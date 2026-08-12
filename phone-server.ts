import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";

const PHONE_PORT = Number(process.env.PHONE_PORT ?? 8091);
const PHONE_TOKEN = process.env.PHONE_TOKEN ?? "yobnh-phone";

let discordClient: any = null;
let ownerIdGetter: () => string = () => "";
let alertsBuffer: any[] = [];
const MAX_ALERTS = 200;
const wsClients = new Set<WebSocket>();

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function authOk(req: http.IncomingMessage): boolean {
  const hdr = req.headers["x-phone-token"];
  if (Array.isArray(hdr)) return hdr.some((v) => v === PHONE_TOKEN);
  return hdr === PHONE_TOKEN;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function broadcastAlert(alert: any): void {
  const msg = JSON.stringify({ type: "alert", data: alert });
  for (const ws of wsClients) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    } catch {}
  }
}

function pushAlert(alert: any): void {
  alertsBuffer.push(alert);
  if (alertsBuffer.length > MAX_ALERTS) alertsBuffer.splice(0, alertsBuffer.length - MAX_ALERTS);
  broadcastAlert(alert);
}

function safeName(name: string): string {
  const base = path.basename(name || "file");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function dmOwnerWithAttachment(filePath: string, caption: string): Promise<boolean> {
  try {
    const owner = await discordClient.users.fetch(ownerIdGetter());
    await owner.send({
      content: caption,
      files: [{ attachment: filePath, name: path.basename(filePath) }],
    });
    return true;
  } catch {
    return false;
  }
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!authOk(req)) {
    unauthorized(res);
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/phone/ping") {
    sendJson(res, 200, {
      ok: true,
      name: "YOBNH-Phone Server",
      connected: Boolean(discordClient),
      ownerSet: Boolean(ownerIdGetter()),
    });
    return;
  }

  if (url.pathname === "/api/phone/alerts" && req.method === "GET") {
    const after = Number(url.searchParams.get("after") || 0);
    const alerts = alertsBuffer.filter((a) => a.id > after);
    sendJson(res, 200, { alerts, now: Date.now() });
    return;
  }

  if (url.pathname === "/api/phone/message" && req.method === "POST") {
    readBody(req)
      .then(async (body) => {
        try {
          const payload = JSON.parse(body);
          const text = String(payload.text || "").trim();
          if (!text) {
            sendJson(res, 400, { error: "Missing text" });
            return;
          }
          if (!discordClient || !ownerIdGetter()) {
            sendJson(res, 503, { error: "Discord client not ready" });
            return;
          }
          const owner = await discordClient.users.fetch(ownerIdGetter());
          await owner.send(`📱 **YOBNH-Phone message:**\n${text}`);
          sendJson(res, 200, { ok: true });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message || "Failed to send message" });
        }
      })
      .catch((err) => sendJson(res, 400, { error: err.message || "Bad request" }));
    return;
  }

  if (url.pathname === "/api/phone/file" && req.method === "POST") {
    readBody(req)
      .then(async (body) => {
        try {
          const payload = JSON.parse(body);
          const data = payload.data || "";
          const name = safeName(payload.name);
          if (!data || !name) {
            sendJson(res, 400, { error: "Missing data or name" });
            return;
          }
          const dir = path.join(process.cwd(), "community-files", "phone-inbox");
          fs.mkdirSync(dir, { recursive: true });
          const filePath = path.join(dir, `${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${name}`);
          fs.writeFileSync(filePath, Buffer.from(data, "base64"));
          const sent = await dmOwnerWithAttachment(filePath, `📎 **File from YOBNH-Phone:** \`${name}\``);
          sendJson(res, 200, { ok: true, sent, file: path.basename(filePath) });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message || "Failed to save file" });
        }
      })
      .catch((err) => sendJson(res, 400, { error: err.message || "Bad request" }));
    return;
  }

  if (url.pathname === "/api/phone/voice" && req.method === "POST") {
    readBody(req)
      .then(async (body) => {
        try {
          const payload = JSON.parse(body);
          const data = payload.data || "";
          const name = safeName(payload.name || "voicemail.ogg");
          if (!data) {
            sendJson(res, 400, { error: "Missing data" });
            return;
          }
          const dir = path.join(process.cwd(), "community-files", "phone-inbox");
          fs.mkdirSync(dir, { recursive: true });
          const filePath = path.join(dir, `${Date.now()}_voicemail_${name}`);
          fs.writeFileSync(filePath, Buffer.from(data, "base64"));
          const sent = await dmOwnerWithAttachment(filePath, `📞 **Voice mail from YOBNH-Phone:** \`${name}\``);
          sendJson(res, 200, { ok: true, sent, file: path.basename(filePath) });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message || "Failed to save voice mail" });
        }
      })
      .catch((err) => sendJson(res, 400, { error: err.message || "Bad request" }));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export interface PhoneServerHandle {
  pushAlert: (alert: any) => void;
  port: number;
}

export function startPhoneServer(client: any, getOwner: () => string): PhoneServerHandle {
  discordClient = client;
  ownerIdGetter = getOwner;

  const server = http.createServer(handleRequest);

  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      const url = new URL(info.req.url || "/", `http://${info.req.headers.host || "localhost"}`);
      done(url.searchParams.get("token") === PHONE_TOKEN);
    },
  });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
  });

  server.listen(PHONE_PORT, () => {
    console.log(`📱 YOBNH-Phone server running on port ${PHONE_PORT}`);
  });

  return {
    pushAlert,
    port: PHONE_PORT,
  };
}
