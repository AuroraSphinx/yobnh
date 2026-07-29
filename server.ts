import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, ChildProcess } from "child_process";

// --- Discord Client Hook ---
function getDiscordClient(): any {
  return (global as any).discordClientInstance || null;
}

const PORT = Number(process.env.ADMIN_PORT ?? 3000);
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "aurora2026";
const LOG_FILE = path.join(__dirname, "bot-errors.log");

// --- Bot Process Management ---
let botProcess: ChildProcess | null = null;
let botRunning = false;
let botCrashed = false;
let botCrashReason = "";
let botStartTime = 0;
const MAX_LOG_LINES = 500;
const botLogs: string[] = [];

function pushBotLog(line: string) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  botLogs.push(`[${ts}] ${line}`);
  if (botLogs.length > MAX_LOG_LINES) botLogs.splice(0, botLogs.length - MAX_LOG_LINES);
}

function startBot(): { success: boolean; message: string } {
  if (botProcess && botRunning) {
    return { success: false, message: "Bot is already running." };
  }

  botCrashed = false;
  botCrashReason = "";

  try {
    botProcess = spawn("npx", ["ts-node", "index.ts"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: false,
    });

    botRunning = true;
    botStartTime = Date.now();
    pushBotLog("Bot process started.");

    botProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) pushBotLog(line);
    });

    botProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) pushBotLog(`[STDERR] ${line}`);
    });

    botProcess.on("exit", (code, signal) => {
      botRunning = false;
      botProcess = null;
      const reason = signal ? `Signal: ${signal}` : `Exit code: ${code}`;
      botCrashed = true;
      botCrashReason = reason;
      pushBotLog(`Bot process exited: ${reason}`);
      console.log(`[BOT] Process exited: ${reason}`);
    });

    botProcess.on("error", (err) => {
      botRunning = false;
      botProcess = null;
      botCrashed = true;
      botCrashReason = err.message;
      pushBotLog(`Bot process error: ${err.message}`);
      console.error(`[BOT] Process error:`, err);
    });

    return { success: true, message: "Bot process started." };
  } catch (err: any) {
    botCrashed = true;
    botCrashReason = err.message;
    pushBotLog(`Failed to start bot: ${err.message}`);
    return { success: false, message: `Failed to start bot: ${err.message}` };
  }
}

function stopBot(): { success: boolean; message: string } {
  if (!botProcess || !botRunning) {
    return { success: false, message: "Bot is not running." };
  }

  try {
    botProcess.kill("SIGTERM");
    botRunning = false;
    pushBotLog("Bot process stopped.");
    return { success: true, message: "Bot process stopped." };
  } catch (err: any) {
    return { success: false, message: `Failed to stop bot: ${err.message}` };
  }
}

function restartBot(): { success: boolean; message: string } {
  const stopResult = stopBot();
  if (!stopResult.success && !stopResult.message.includes("not running")) {
    return stopResult;
  }
  setTimeout(() => startBot(), 1000);
  pushBotLog("Bot process restarting...");
  return { success: true, message: "Bot restarting..." };
}

function getBotUptime(): string {
  if (!botRunning || botStartTime === 0) return "N/A";
  const ms = Date.now() - botStartTime;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// --- Anti-Spam Rate Limiter Configuration ---
const dmTracker = new Map<string, number[]>();
const MAX_MESSAGES_PER_MINUTE = 3;

function isSpamming(userId: string): boolean {
  const now = Date.now();
  if (!dmTracker.has(userId)) {
    dmTracker.set(userId, [now]);
    return false;
  }

  const timestamps = dmTracker.get(userId)!;
  const oneMinuteAgo = now - 60000;
  const recentSends = timestamps.filter(time => time > oneMinuteAgo);

  if (recentSends.length >= MAX_MESSAGES_PER_MINUTE) {
    return true;
  }

  recentSends.push(now);
  dmTracker.set(userId, recentSends);
  return false;
}

function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="AuroraSphinx Admin"',
      "Content-Type": "text/plain",
    });
    res.end("Access denied.");
    return false;
  }

  const [user, ...rest] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  const pass = rest.join(":");
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="AuroraSphinx Admin"',
      "Content-Type": "text/plain",
    });
    res.end("Access denied.");
    return false;
  }

  return true;
}

function readErrors(): unknown[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is unknown => entry !== null)
      .reverse()
      .slice(0, 50);
  } catch {
    return [];
  }
}

function getSystemStats() {
  try {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((core) => {
      for (const type in core.times) {
        totalTick += (core.times as any)[type];
      }
      totalIdle += core.times.idle;
    });

    const totalUsed = totalTick - totalIdle;
    const cpuPercent = totalTick > 0 ? ((totalUsed / totalTick) * 100).toFixed(1) : "0.0";

    return {
      status: "online",
      cpuUsage: cpuPercent,
    };
  } catch (err) {
    return { status: "offline", cpuUsage: "0.0" };
  }
}

function getMemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total: (total / 1024 / 1024 / 1024).toFixed(1),
    used: (used / 1024 / 1024 / 1024).toFixed(1),
    percent: ((used / total) * 100).toFixed(1),
  };
}

function getUptime(): string {
  const seconds = Math.floor(os.uptime());
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

  // --- Bot Control Endpoints ---
  if (req.url === "/api/bot/start" && req.method === "POST") {
    const result = startBot();
    res.writeHead(result.success ? 200 : 409, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === "/api/bot/stop" && req.method === "POST") {
    const result = stopBot();
    res.writeHead(result.success ? 200 : 409, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === "/api/bot/restart" && req.method === "POST") {
    const result = restartBot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === "/api/bot/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: botRunning,
      crashed: botCrashed,
      crashReason: botCrashReason,
      uptime: getBotUptime(),
    }));
    return;
  }

  if (req.url === "/api/bot/logs") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const since = Number(url.searchParams.get("since")) || 0;
    const logs = since > 0 ? botLogs.slice(since) : botLogs;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs, total: botLogs.length }));
    return;
  }

  if (req.url === "/api/bot/crash-ack" && req.method === "POST") {
    botCrashed = false;
    botCrashReason = "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // --- Direct DM dispatch pipeline routing logic ---
  if (req.url === "/api/send-dm" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const { userId, message } = payload;

        if (!userId || !message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing userId or message data payload values." }));
          return;
        }

        const cleanUserId = userId.trim();

        if (isSpamming(cleanUserId)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Rate limit reached! You are sending too many messages to this user ID too quickly."
          }));
          return;
        }

        const clientInstance = getDiscordClient();

        if (!clientInstance) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Discord bot client is not initialized yet." }));
          return;
        }

        let targetUser;
        try {
          targetUser = await clientInstance.users.fetch(cleanUserId, { force: true });
        } catch (fetchErr) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Discord User ID "${cleanUserId}" was not found.` }));
          return;
        }

        const sharedGuilds = clientInstance.guilds.cache.filter((guild: any) => guild.members.cache.has(cleanUserId));
        if (sharedGuilds.size === 0) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `Cannot send DM. The bot does not share any Discord servers with this user.`
          }));
          return;
        }

        try {
          const dmChannel = await targetUser.createDM();
          await dmChannel.send(message.trim());
          console.log(`Successfully delivered dashboard message to user: ${targetUser.tag}`);
        } catch (sendErr: any) {
          console.error("Internal DM Dispatch Error Details:", sendErr);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `Failed to deliver text. This user likely blocks DMs from non-friends or has privacy settings locked.`
          }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Failed to process direct message request." }));
      }
    });
    return;
  }

  // --- Ask AI Command Endpoint ---
  if (req.url === "/api/ask" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const { prompt } = payload;

        if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing or empty prompt value." }));
          return;
        }

        const askFn = (global as any).askAI;
        if (!askFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "AI system is not initialized yet." }));
          return;
        }

        const reply = await askFn(prompt.trim());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, reply }));
      } catch (err: any) {
        console.error("Ask AI Error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Failed to process AI request." }));
      }
    });
    return;
  }

  // --- Live Metrics Stats API ---
  if (req.url === "/api/stats") {
    try {
      const systemData = getSystemStats();
      const errors = readErrors();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        cpu: systemData.cpuUsage,
        mem: getMemStats(),
        uptime: getUptime(),
        bot: { online: botRunning },
        errors
      }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cpu: "0.0", mem: getMemStats(), uptime: getUptime(), bot: { online: false }, errors: [] }));
    }
    return;
  }

  // --- Serve Admin Panel Web View ---
  if (req.url === "/" || req.url === "/admin.html") {
    const filePath = path.join(__dirname, "admin.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("admin.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Admin panel running at http://localhost:${PORT}`);
});
