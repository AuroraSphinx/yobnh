const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const ssh = require('./config');

const app = express();
const server = http.createServer(app);

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

const wss = new WebSocketServer({ server, verifyClient: (info, done) => done(authOk(info.req)) });

function spawnShell(ws) {
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
    opts.privateKey = Buffer.from(ssh.key);
  } else {
    opts.password = ssh.password;
  }
  conn.connect(opts);
}

wss.on('connection', (ws) => {
  spawnShell(ws);

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }
    switch (data.type) {
      case 'input':
        if (ws.stream) ws.stream.write(data.text);
        break;
      case 'resize':
        if (ws.stream) ws.stream.setWindow(data.rows, data.cols, data.height, data.width);
        break;
    }
  });

  ws.on('close', () => {
    if (ws.stream) ws.stream.end();
    if (ws.conn) ws.conn.end();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Linux terminal running at http://localhost:${PORT}`);
});
