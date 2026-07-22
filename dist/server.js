"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const PORT = Number(process.env.ADMIN_PORT ?? 3000);
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "aurora2026";
const LOG_FILE = path_1.default.join(__dirname, "bot-errors.log");
function checkAuth(req, res) {
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
function readErrors() {
    try {
        if (!fs_1.default.existsSync(LOG_FILE))
            return [];
        const lines = fs_1.default.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
        return lines
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((entry) => entry !== null)
            .reverse()
            .slice(0, 50);
    }
    catch {
        return [];
    }
}
function getBotStatus(callback) {
    (0, child_process_1.exec)(`tasklist /FI "IMAGENAME eq node.exe" /FO CSV`, (err, stdout) => {
        if (err)
            return callback({ online: false });
        callback({ online: stdout.includes("node.exe") });
    });
}
function getCpuUsage(callback) {
    const start = os_1.default.cpus().map((c) => c.times);
    setTimeout(() => {
        const end = os_1.default.cpus().map((c) => c.times);
        const usage = start.map((s, i) => {
            const e = end[i];
            const idle = e.idle - s.idle;
            const total = Object.values(e).reduce((a, b) => a + b, 0) - Object.values(s).reduce((a, b) => a + b, 0);
            return 100 - (idle / total) * 100;
        });
        callback((usage.reduce((a, b) => a + b, 0) / usage.length).toFixed(1));
    }, 500);
}
function getMemStats() {
    const total = os_1.default.totalmem();
    const free = os_1.default.freemem();
    const used = total - free;
    return {
        total: (total / 1024 / 1024 / 1024).toFixed(1),
        used: (used / 1024 / 1024 / 1024).toFixed(1),
        percent: ((used / total) * 100).toFixed(1),
    };
}
function getUptime() {
    const seconds = Math.floor(os_1.default.uptime());
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${secs}`;
}
const server = http_1.default.createServer((req, res) => {
    if (!checkAuth(req, res))
        return;
    if (req.url === "/api/stats") {
        getCpuUsage((cpu) => {
            getBotStatus((bot) => {
                const errors = readErrors();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ cpu, mem: getMemStats(), uptime: getUptime(), bot, errors }));
            });
        });
        return;
    }
    if (req.url === "/" || req.url === "/admin.html") {
        const filePath = path_1.default.join(__dirname, "admin.html");
        fs_1.default.readFile(filePath, (err, data) => {
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
