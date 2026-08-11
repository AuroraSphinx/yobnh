const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const { spawn: spawnProcess } = require('child_process');
const ssh = require('./config');
const pkg = require('./package.json');

const app = express();
const server = http.createServer(app);

// Browsers can't send Authorization headers on WebSocket connections, so the
// WS handshake uses a token instead of Basic auth. The token is handed out by
// /ws-config (which IS behind Basic auth) to the page.
const wsToken = crypto.randomBytes(24).toString('hex');

function authOk(req) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':');
  return user === ssh.authUser && pass === ssh.authPass;
}

app.use((req, res, next) => {
  if (authOk(req)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="YOBNH Terminal"');
  res.status(401).send('401 Unauthorized');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/terminal.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ws-config', (req, res) => {
  res.json({ token: wsToken, version: pkg.version });
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info, done) => {
    const url = new URL(info.req.url, 'http://' + (info.req.headers.host || 'localhost'));
    done(url.searchParams.get('token') === wsToken);
  },
});

function resolveShell() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\bash.exe',
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); return c; } catch (e) {}
    }
    return 'bash';
  }
  return process.env.SHELL || '/bin/bash';
}

function spawnShell(ws) {
  if (ssh.localShell) {
    const shell = resolveShell();
    let attempts = 0;
    const start = (useScript) => {
      let dead = false;
      const markDead = () => { dead = true; };
      const args = useScript ? ['-qfec', shell + ' --login', '/dev/null'] : ['--login'];
      const child = spawnProcess(useScript ? 'script' : shell, args, {
        cwd: process.env.HOME || '/',
        env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '150', LINES: '40' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      ws.stream = child.stdin;
      ws.child = child;
      child.stdout.on('data', (data) => {
        try { ws.send(JSON.stringify({ type: 'data', text: data.toString('utf8') })); } catch (e) {}
      });
      child.stderr.on('data', (data) => {
        try { ws.send(JSON.stringify({ type: 'data', text: data.toString('utf8') })); } catch (e) {}
      });
      child.on('error', (err) => {
        if (dead) return;
        markDead();
        try { ws.send(JSON.stringify({ type: 'status', text: 'Shell error: ' + err.message })); } catch (e) {}
        if (useScript && err.code === 'ENOENT') {
          start(false);
        } else {
          try { ws.close(); } catch (e) {}
        }
      });
      child.on('close', () => {
        if (dead) return;
        markDead();
        if (ws.readyState === 1 && attempts < 3) {
          attempts += 1;
          try { ws.send(JSON.stringify({ type: 'status', text: '\r\n[shell closed, restarting...]' })); } catch (e) {}
          setTimeout(() => start(true), 1500);
        }
      });
    };
    start(true);
    try { ws.send(JSON.stringify({ type: 'status', text: 'Connected. Local shell ready.' })); } catch (e) {}
    return;
  }

  const conn = new Client();

  conn.on('ready', () => {
    ws.send(JSON.stringify({ type: 'status', text: 'Connected. Opening shell...' }));
    conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'status', text: 'Shell error: ' + err.message }));
        conn.end();
        return;
      }
      ws.send(JSON.stringify({ type: 'status', text: 'Shell ready.' }));

      stream.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'data', text: data.toString('utf8') }));
      });

      stream.on('close', () => {
        ws.send(JSON.stringify({ type: 'status', text: '\r\n[connection closed by remote host]' }));
        conn.end();
        ws.close();
      });

      ws.conn = conn;
      ws.stream = stream;

      if (ssh.tmuxSession) {
        stream.write(`tmux attach -t ${ssh.tmuxSession} 2>/dev/null || tmux new -s ${ssh.tmuxSession}\r`);
      }
    });
  });

  conn.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'status', text: 'SSH error: ' + err.message }));
    try { ws.close(); } catch (e) {}
  });

  conn.on('close', () => {
    try { ws.close(); } catch (e) {}
  });

  const opts = { host: ssh.host, port: ssh.port || 22, username: ssh.username, readyTimeout: 15000 };
  if (ssh.auth === 'key') {
    if (!ssh.key) {
      ws.send(JSON.stringify({ type: 'status', text: 'Config error: no SSH key set (SSH_KEY env or config.js).' }));
      try { ws.close(); } catch (e) {}
      return;
    }
    opts.privateKey = Buffer.from(ssh.key);
  } else {
    if (!ssh.password) {
      ws.send(JSON.stringify({ type: 'status', text: 'Config error: no SSH password set (SSH_PASSWORD env or config.js).' }));
      try { ws.close(); } catch (e) {}
      return;
    }
    opts.password = ssh.password;
  }
  conn.connect(opts);
}

wss.on('connection', (ws) => {
  try {
    spawnShell(ws);
  } catch (err) {
    try { ws.send(JSON.stringify({ type: 'status', text: 'Shell error: ' + err.message })); } catch (e) {}
  }

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }
    try {
      switch (data.type) {
        case 'input':
          if (ws.stream) ws.stream.write(data.text);
          break;
        case 'resize':
          if (ws.stream && typeof ws.stream.setWindow === 'function') {
            ws.stream.setWindow(data.rows, data.cols, data.height, data.width);
          }
          break;
      }
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'status', text: 'Terminal error: ' + err.message })); } catch (e) {}
    }
  });

  ws.on('close', () => {
    try { if (ws.stream) ws.stream.end(); } catch (e) {}
    try { if (ws.conn) ws.conn.end(); } catch (e) {}
  });
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.TERMINAL_URL || `https://llama-vs-red.exe.xyz:${PORT}`;
server.listen(PORT, () => {
  console.log(`Linux terminal running at ${HOST}`);
  console.log(`WebSocket token configured. Access the terminal at ${HOST}/terminal.html`);
});
