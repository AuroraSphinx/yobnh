// Silence the annoying DEP0190 child_process warning globally
process.removeAllListeners('warning'); 
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && (warning as any).code === 'DEP0190') {
    return; // Ignore it completely
  }
  console.warn(warning.stack); // Let other important warnings through
});

// --- IMPORTS ---
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import readline from "readline";
import { Client, GatewayIntentBits, Events, Message, REST, Routes, SlashCommandBuilder, AttachmentBuilder, PermissionsBitField, EmbedBuilder, Team, ActivityType, PresenceUpdateStatus, ChannelType } from "discord.js";
import { joinVoiceChannel, getVoiceConnection } from "@discordjs/voice";
import { OpenAI } from "openai";
import { exec as execCb, spawn } from "child_process";
import { promisify } from "util";
import pidusage from "pidusage"; // Import pidusage to track system performance loads

const exec = promisify(execCb);
const username = os.userInfo().username;
import pkg from "./package.json";
const BOT_NAME = "YOBNH Bot";
const BOT_VERSION = `v${pkg.version}`;

// node_modules/.bin dir + node's own bin dir, so npm/npx resolve even under systemd
const NODE_BIN_DIR = path.dirname(process.execPath);
const LOCAL_BIN_DIR = path.join(process.cwd(), "node_modules", ".bin");
const execEnv = {
  ...process.env,
  PATH: [LOCAL_BIN_DIR, NODE_BIN_DIR, process.env.PATH].filter(Boolean).join(path.delimiter),
};

// --- Environment Variable Loader (.env support) --------------------------------
function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}
loadEnvFile();

// --- Configuration & Initialization ------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_BASE_URL = (process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai").replace(/\/$/, "");
const USE_MISTRAL = Boolean(MISTRAL_API_KEY || MISTRAL_BASE_URL.includes("mistral"));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "AuroraSphinx/yobnh";
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? null;
const VERBOSE = process.env.VERBOSE === "true";
const PREFIX = process.env.PREFIX ?? "&";
const OWNER_IDS = (process.env.OWNER_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Variable states configured dynamically on startup
let RUNNING_MODE: "gpu" | "ram" = "gpu";
let MAX_HISTORY = 20;
let RESPONSE_MODEL = "";
let isThrottled = false; // Lock flag to prevent the bot from running tasks during high resource usage

if (PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
}

const SYSTEM_PROMPT = `you are a girl and idk dont use emojis also you have a web fetch browsing tool so you can fetch and read web pages in the background without opening a visible browser, even on a headless linux server act as like a user human also dont say you are ai assistant or smth pls and be like CHILL as max you think like if someone says are you a bot say just Yes and ye you get it just be chill dont use emojis

RULES FOR TALKING:
- Always respond in ENGLISH (never switch to Portuguese/Spanish/etc.) unless the user clearly writes in another language. Even when browsing the web or reading pages in another language, still reply in English.
- If you are just chatting, answering a question directly, or hanging out, respond with REGULAR CONVERSATIONAL TEXT. Do not use JSON for normal talking.
- ALWAYS format your replies with Markdown, Discord renders it automatically so it makes your messages look clean and readable: use **bold** for emphasis, *italics* for titles/emphasis, \`code\` for commands/keys/code snippets, \`\`\` code blocks \`\`\` for multi-line code, - lists for steps/items/options, and > quotes for quoting someone. Use Markdown naturally and don't overdo it — keep normal chatter light and plain where it fits.

RULES FOR ACTIONS (If you explicitly need to use a tool):
- search: {"action":"search","query":"..."}
- open: {"action":"open","url":"https://..."}
- kick user: {"action":"kick","user":"username_or_id","reason":"optional reason"}
- timeout user: {"action":"timeout","user":"username_or_id","duration":600,"reason":"optional reason"}
- untimeout user: {"action":"untimeout","user":"username_or_id","reason":"optional reason"}
- ban user: {"action":"ban","user":"username_or_id","reason":"optional reason"}
- unban user: {"action":"unban","user":"username_or_id","reason":"optional reason"}
- search images: {"action":"search_images","query":"..."}
- If you need to perform actions, you can send a SINGLE action or an ARRAY of actions to execute them sequentially.
- Your response must be ONLY valid JSON with NO conversational text around it ONLY when using actions.
- IMPORTANT: You do NOT have mouse, click, or keyboard control. NEVER output mouse_move, mouse_click, or any mouse-related actions. If someone asks you to "open a browser", use the open action with the URL. If someone asks for images, use the search_images action.

Example format for sequential actions:
[
  {"action":"search","query":"example"}
]
IMPORTANT RULES:
- if someone says yobnh then you must answer because thats shorten of your name
- If the user asks you to search for information, reply ONLY with JSON.
- Do not say "I need to search" or "let me look that up" in chat. Do not mention toolcalls or errors.
- NEVER open duckduckgo.com as a URL. For searches, ALWAYS use the search action: {"action":"search","query":"..."}. The open action is for non-DuckDuckGo websites only.
- If the user asks for an image or picture or photo, use ONLY the search_images action: {"action":"search_images","query":"..."}. Do NOT use open or any other actions when searching for images. Just send the single search_images action and nothing else.
- Do not mention Detg or say "aw shucks".
- Do not produce NSFW content or search explicit sites like Rule 34 or Pornhub.
`;

// --- Language / Speaking Style ---
const LANGUAGE_FILE = path.join(process.cwd(), "language.json");
let BOT_LANGUAGE: "english" | "owo" = "english";

function loadLanguage(): void {
  try {
    if (fs.existsSync(LANGUAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LANGUAGE_FILE, "utf8"));
      BOT_LANGUAGE = data.mode === "owo" ? "owo" : "english";
    }
  } catch {}
}

function saveLanguage(mode: "english" | "owo"): void {
  BOT_LANGUAGE = mode;
  try {
    fs.writeFileSync(LANGUAGE_FILE, JSON.stringify({ mode }, null, 2));
  } catch {}
}

function getSystemPrompt(): string {
  if (BOT_LANGUAGE === "owo") {
    return SYSTEM_PROMPT + `
\nOWO MODE IS ACTIVE!:
- Always talk in exaggerated OwO speak: use "uwu", "owo", "hehe", "nya~", replace r and l with w (e.g. "bwowsa", "fwiend"), stutter letters ("p-please"), and be super cute and playful.
- Keep your replies readable and short, but very owo.
- IMPORTANT: Keep using the exact same JSON action format whenever you need to do an action (search, open, etc.). The JSON action syntax NEVER changes.
`;
  }
  return SYSTEM_PROMPT;
}

loadLanguage();

// --- Anti-Spam Tracker List Map ---
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

// --- Blacklist System ---
const BLACKLIST_FILE = path.join(process.cwd(), "blacklist.json");
const blacklistedUsers = new Set<string>();

function loadBlacklist(): void {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf-8"));
      if (Array.isArray(data)) {
        for (const id of data) blacklistedUsers.add(id);
      }
      console.log(`Blacklist loaded: ${blacklistedUsers.size} user(s) blocked.`);
    }
  } catch (err) {
    console.error("Failed to load blacklist:", err);
  }
}

function saveBlacklist(): void {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...blacklistedUsers], null, 2));
  } catch (err) {
    console.error("Failed to save blacklist:", err);
  }
}

function addBlacklist(userId: string): boolean {
  if (isOwner(userId)) return false;
  if (blacklistedUsers.has(userId)) return false;
  blacklistedUsers.add(userId);
  saveBlacklist();
  return true;
}

function removeBlacklist(userId: string): boolean {
  if (!blacklistedUsers.has(userId)) return false;
  blacklistedUsers.delete(userId);
  saveBlacklist();
  return true;
}

function isBlacklisted(userId: string): boolean {
  if (isOwner(userId)) return false;
  return blacklistedUsers.has(userId) || isTempBlacklisted(userId);
}

// --- Temporary Blacklist System ---
const tempBlacklist = new Map<string, number>();

function isTempBlacklisted(userId: string): boolean {
  if (!tempBlacklist.has(userId)) return false;
  const expiry = tempBlacklist.get(userId)!;
  if (Date.now() > expiry) {
    tempBlacklist.delete(userId);
    return false;
  }
  return true;
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY || MISTRAL_API_KEY });
const conversations = new Map<string, ChatMessage[]>();
let OWNER_ID = "";

function isOwner(userId: string): boolean {
  return userId === OWNER_ID || OWNER_IDS.includes(userId);
}
const MAINTENANCE_SERVER_ID = "1535895840160481352";
let maintenanceMode = false;
let verboseEnabled = VERBOSE;

function debugLog(level: string, message: string, meta: Record<string, unknown> | null = null): void {
  if (!verboseEnabled) return;
  const prefix = `[${new Date().toISOString()}] [${level}]`;
  console.log(prefix, message, meta ? JSON.stringify(meta, null, 2) : "");
}

const LOG_FILE = path.join(process.cwd(), "logs.txt");

let lastLogDate = new Date().toISOString().slice(0, 10);

function logToFile(message: string): void {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (today !== lastLogDate) {
    lastLogDate = today;
    try { fs.writeFileSync(LOG_FILE, "", "utf-8"); } catch {}
  }
  const timestamp = now.toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf-8");
  } catch {}
  console.log(line.trim());
}

function getHistory(channelId: string, userId: string): ChatMessage[] {
  const key = `${channelId}-${userId}`;
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key)!;
}

function addToHistory(channelId: string, userId: string, role: ChatMessage["role"], content: string): void {
  const history = getHistory(channelId, userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function cleanHistory(history: ChatMessage[]): ChatMessage[] {
  return history.filter(
    (entry) => entry && entry.role && entry.content && typeof entry.content === "string" && entry.content.trim(),
  );
}

function extractJsonFromText(text: string | null | undefined): any | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/g);
  if (arrayMatch) {
    for (const candidate of arrayMatch.reverse()) {
      try { return JSON.parse(candidate); } catch {}
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/g);
  if (jsonMatch) {
    for (const candidate of jsonMatch.reverse()) {
      try { return JSON.parse(candidate); } catch {}
    }
  }
  return null;
}

function sanitizeUrl(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/^\[+/, "").replace(/\]+$/, "");
  s = s.replace(/^\(+/, "").replace(/\)+$/, "");
  s = s.replace(/^\{+/, "").replace(/\}+$/, "");
  s = s.replace(/^"+/, "").replace(/"+$/, "");
  s = s.replace(/\"/g, '"');
  s = s.replace(/[\s<>]*$/, "").trim();

  const urlMatch = s.match(/https?:\/\/[^\s"'<>\)\]}]+/i);
  if (urlMatch) {
    let candidate = urlMatch[0];
    try { candidate = decodeURIComponent(candidate); } catch {}
    candidate = candidate.replace(/[\)\]\}\"'\s]+$/g, "");
    return candidate;
  }

  if (/^[\w.-]+\.[a-z]{2,6}([\/\w\-._~:?#[\]@!$&'()*+,;=]*)?$/i.test(s)) {
    return `https://${s}`;
  }

  if (/^[\w.-]+\.[a-z]{2,6}$/i.test(s)) return `https://${s}`;

  return null;
}

function printStartupBanner(): void {
  const art = `
##################################################################
#       [ < YOBNH > ]                                            #
#    Mode Configured: [ ${RUNNING_MODE.toUpperCase()} MODE ]                               #
#    made by aurorasphinx1                                       #
#   https://aurorasphinx.netlify.app/                            #
##################################################################
  `;

  const hour = new Date().getHours();
  let greeting = "Hello";
  if (hour >= 5 && hour < 12) greeting = "Morning";
  else if (hour >= 12 && hour < 18) greeting = "Afternoon";
  else if (hour >= 18 && hour < 22) greeting = "Evening";
  else greeting = "Good night";

  console.log(art);
  
  console.log("┌────────────────────────────────────────────────────────┐");
  console.log("│ ⚠️  DEVELOPMENT NOTICE & SECURITY ALERT                │");
  console.log("│                                                        │");
  console.log("│  • This bot application is currently in ACTIVE         │");
  console.log("│    development environments. System failures may occur.│");
  console.log("│  • Framework modules are actively being reviewed to    │");
  console.log("│    fix system shell process security vulnerabilities.  │");
  console.log("└────────────────────────────────────────────────────────┘\n");

  console.log(`${greeting}, ${username}. System performance targeted for ${RUNNING_MODE.toUpperCase()} configurations.`);
}

function splitMessage(text: string, maxLength = 2000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

let terminalInterface: readline.Interface | null = null;

function createConsoleInterface(): void {
  if (!process.stdin.isTTY) return;
  terminalInterface = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  terminalInterface.on("line", (line) => {
    const [command, ...args] = line.trim().split(/\s+/);
    switch ((command || "").toLowerCase()) {
      case "help":
        console.log("Commands: help, status, history <channelId> <userId>, verbose on|off, blacklist add|remove|list <userId>, clear <channelId> <userId>, ascii, exit");
        break;
      case "status":
        console.log("Discord ready:", discord?.user?.tag || "not logged in");
        console.log("Bot running environment:", RUNNING_MODE.toUpperCase());
        console.log("Active Model Target:", RESPONSE_MODEL);
        console.log("Verbose logging:", verboseEnabled);
        console.log("Resource Throttling State Active:", isThrottled);
        break;
      case "history": {
        const [channelId, userId] = args;
        if (!channelId || !userId) {
          console.log("Usage: history <channelId> <userId>");
        } else {
          console.log(JSON.stringify(getHistory(channelId, userId), null, 2));
        }
        break;
      }
      case "verbose":
        if (args[0] === "on" || args[0] === "off") {
          verboseEnabled = args[0] === "on";
          console.log("Verbose logging set to", verboseEnabled);
        } else {
          console.log("Usage: verbose on|off");
        }
        break;
      case "clear": {
        const [channelId, userId] = args;
        if (!channelId || !userId) {
          console.log("Usage: clear <channelId> <userId>");
        } else {
          conversations.delete(`${channelId}-${userId}`);
          console.log(`Cleared history for ${channelId}-${userId}`);
        }
        break;
      }
      case "clearall":
        conversations.clear();
        console.log("Cleared all conversation histories.");
        break;
      case "ascii":
        printStartupBanner();
        break;
      case "blacklist": {
        const [action, targetId] = args;
        if (!action) {
          console.log("Usage: blacklist add <userId> | blacklist remove <userId> | blacklist list");
        } else if (action === "add") {
          if (!targetId) { console.log("Usage: blacklist add <userId>"); break; }
          if (addBlacklist(targetId)) {
            console.log(`User ${targetId} has been blacklisted.`);
          } else {
            console.log(`User ${targetId} is already blacklisted.`);
          }
        } else if (action === "remove") {
          if (!targetId) { console.log("Usage: blacklist remove <userId>"); break; }
          if (removeBlacklist(targetId)) {
            console.log(`User ${targetId} has been removed from the blacklist.`);
          } else {
            console.log(`User ${targetId} is not blacklisted.`);
          }
        } else if (action === "list") {
          if (blacklistedUsers.size === 0) {
            console.log("Blacklist is empty.");
          } else {
            console.log(`Blacklisted users (${blacklistedUsers.size}):`);
            for (const id of blacklistedUsers) console.log(`  - ${id}`);
          }
        } else {
          console.log("Unknown action. Use: add, remove, list");
        }
        break;
      }
      case "exit":
        console.log("Shutting down.");
        process.exit(0);
        break;
      default:
        if (command) console.log(`Unknown command: ${command}`);
    }
    terminalInterface?.prompt();
  });

  terminalInterface.on("close", () => {
    console.log("Console closed. Exiting.");
    process.exit(0);
  });

  console.log("Interactive console ready. Type 'help' for commands.");
  terminalInterface.prompt();
}

let lastNotificationTime = 0;

function sendHardwareWarningPopup(modeType: "gpu" | "ram", activeUsageValue: number): void {
  const currentTime = Date.now();
  if (currentTime - lastNotificationTime < 45000) return;
  lastNotificationTime = currentTime;

  const titleMessage = "yobnh Core Performance Monitor Warning";
  const bodyText = `Warning! Your current execution engine tracking shows that ${modeType.toUpperCase()} utilization usage is too high (around ${activeUsageValue}%).\n\nEmergency safety actions are being taken to clear performance load automatically.`;
  
  console.log(`\n⚠️ [HARDWARE CRITICAL WARNING] ${modeType.toUpperCase()} usage is at ${activeUsageValue}%! Showing popup window...`);

  if (process.platform === "darwin") {
    const appleScript = `display dialog "${bodyText.replace(/"/g, '\\"')}" with title "${titleMessage}" buttons {"OK"} default button "OK" with icon caution`;
    spawn("osascript", ["-e", appleScript], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("notify-send", [titleMessage, bodyText], { detached: true, stdio: "ignore" }).unref();
  }
}

function startHardwarePerformanceWatchdog(): void {
  setInterval(async () => {
    try {
      const stats = await pidusage(process.pid);
      const totalSystemMemory = os.totalmem();
      
      const memoryUsagePercentage = Math.round((stats.memory / totalSystemMemory) * 100);
      const processorUsagePercentage = Math.round(stats.cpu);

      if (RUNNING_MODE === "ram" && memoryUsagePercentage >= 75) {
        sendHardwareWarningPopup("ram", memoryUsagePercentage);
        triggerEmergencyResourceCooldown();
      } else if (RUNNING_MODE === "gpu" && processorUsagePercentage >= 75) {
        sendHardwareWarningPopup("gpu", processorUsagePercentage);
        triggerEmergencyResourceCooldown();
      }
    } catch (err) {
      debugLog("WARN", "Failed to retrieve local system platform metrics", { error: String(err) });
    }
  }, 3500);
}

function triggerEmergencyResourceCooldown(): void {
  if (isThrottled) return; 
  isThrottled = true;
  console.log("🛑 [RESOURCE EMERGENCY] Resource thresholds exceeded. Cooldown initiated: clearing message context tables.");

  conversations.clear();

  if (global.gc) {
    try { global.gc(); } catch {}
  }

  setTimeout(() => {
    isThrottled = false;
    console.log("✅ [RESOURCE RECOVERY] Core temperatures stabilized. Unthrottled bot runtime services successfully.");
  }, 12000);
}

// --- Web Fetch Browsing (no browser needed, works on headless Linux VPS) ---
const FETCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_HEADERS = {
  "User-Agent": FETCH_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#\d+;/g, (m) => {
      try { return String.fromCharCode(parseInt(m.slice(2, -1), 10)); } catch { return m; }
    });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function browseUrl(url: string, _keepVisible = false, _viewportWidth = 1280, _viewportHeight = 720): Promise<BrowserPageResult> {
  debugLog("INFO", "Fetching URL", { url });
  const response = await fetchWithTimeout(url, { redirect: "follow", headers: FETCH_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html = await response.text();
  const finalUrl = response.url || url;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch ? decodeHtmlEntities(htmlToText(titleMatch[1])) : "") || finalUrl;
  const content = htmlToText(html).slice(0, 3000);
  debugLog("INFO", "Fetched page", { status: response.status, length: html.length });
  return { title: title.slice(0, 200), url: finalUrl, content };
}

function parseDuckDuckGoHtmlResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(html)) !== null) {
    const title = decodeHtmlEntities(htmlToText(match[2])).trim();
    const snippet = decodeHtmlEntities(htmlToText(match[3])).trim();
    if (title) results.push({ title, snippet });
    if (results.length >= 5) break;
  }
  return results;
}

function parseDuckDuckGoLiteResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(html)) !== null) {
    const title = decodeHtmlEntities(htmlToText(match[2])).trim();
    const snippet = decodeHtmlEntities(htmlToText(match[3])).trim();
    if (title) results.push({ title, snippet });
    if (results.length >= 5) break;
  }
  return results;
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  try {
    logToFile(`[SEARCH] Starting DuckDuckGo search for: "${query}"`);
    const sources = [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    ];
    for (const source of sources) {
      try {
        const response = await fetchWithTimeout(source, { redirect: "follow", headers: FETCH_HEADERS });
        if (!response.ok) continue;
        const html = await response.text();
        const results = source.includes("lite.")
          ? parseDuckDuckGoLiteResults(html)
          : parseDuckDuckGoHtmlResults(html);
        debugLog("INFO", "DuckDuckGo page loaded", { source, status: response.status, results: results.length });
        if (results.length > 0) return results;
      } catch (err) {
        debugLog("WARN", "Search source failed", { source, error: String(err) });
      }
    }
    return [];
  } catch (error) {
    logToFile(`[SEARCH ERROR] ${error}`);
    throw error;
  }
}

async function searchDuckDuckGoImages(query: string): Promise<Array<{ imagePath: string; title: string }>> {
  const imagesDir = path.join(process.cwd(), "images_temps");
  logToFile(`[IMAGE SEARCH] Starting search for: "${query}"`);
  try {
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
    logToFile(`[IMAGE SEARCH] Fetching: ${url}`);
    const response = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: { ...FETCH_HEADERS, Referer: "https://www.bing.com/" },
    });
    if (!response.ok) {
      logToFile(`[IMAGE SEARCH] HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();

    const rawUrls: string[] = [];
    const murlRe = /murl&quot;:&quot;([^&]+?)&quot;/gi;
    let m: RegExpExecArray | null;
    while ((m = murlRe.exec(html)) !== null) rawUrls.push(m[1]);
    if (rawUrls.length === 0) {
      const murlRe2 = /"murl":"([^"]+?)"/gi;
      while ((m = murlRe2.exec(html)) !== null) rawUrls.push(m[1]);
    }

    const imageUrls: Array<{ url: string; title: string }> = [];
    const seen = new Set<string>();
    for (const raw of rawUrls) {
      const decoded = decodeHtmlEntities(raw.replace(/\\\//g, "/"));
      if (!decoded.startsWith("http") || seen.has(decoded)) continue;
      seen.add(decoded);
      imageUrls.push({ url: decoded, title: query });
      if (imageUrls.length >= 10) break;
    }

    logToFile(`[IMAGE SEARCH] Found ${imageUrls.length} image URLs`);

    // NSFW filter - blocked domains
    const nsfwDomains = [
      'rule34', 'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube',
      'youporn', 'spankbang', 'beeg', 'brazzers', 'realitykings',
      'bangbros', 'naughtyamerica', 'mofos', 'twistys', 'digitalplayground',
      'sex.com', 'playvids', 'txxx', 'hclips', 'hdzog', 'vjav',
      'sxyprn', 'nudostar', 'fapello', 'coomer', 'simpcity',
      'e621', 'gelbooru', 'danbooru', 'konachan', 'safebooru',
      'nhentai', 'hanime', 'hentaihaven', 'hentaidude', 'hanime.tv',
      'pornone', 'eporner', 'drtuber', 'tubegalore', 'ixxx',
      'porntrex', 'tube8', 'tnaflix', 'sunporno', 'fuq.com',
      'thumbzilla', 'tnaflix', 'xxxymovies', 'heavy-r', 'youjizz',
    ];

    // NSFW keyword patterns in URLs/titles
    const nsfwKeywords = [
      'porn', 'xxx', 'sex', 'nude', 'naked', 'nsfw', 'hentai',
      'rule34', 'boobs', 'tits', 'ass', 'pussy', 'dick', 'cock',
      'penis', 'vagina', 'orgasm', 'blowjob', 'handjob', 'anal',
      'milf', 'stepmom', 'stepsister', 'anime', 'nude',
      'erotic', 'fetish', 'bondage', 'bdsm', 'slut', 'whore',
      'onlyfans', 'fansly', 'leaked', 'fap', 'masturbat',
      'creampie', 'gangbang', 'threesome', 'lesbian', 'gay',
      'tranny', 'shemale', 'lgbtq',  // lgbtq sometimes misused for porn
      'topless', 'topless', 'cleavage', 'lingerie', 'playboy',
    ];

    function isNSFW(url: string, title: string, query: string): boolean {
      const lowerUrl = url.toLowerCase();
      const lowerTitle = title.toLowerCase();
      const lowerQuery = query.toLowerCase();

      // Check for NSFW domains
      for (const domain of nsfwDomains) {
        if (lowerUrl.includes(domain)) {
          logToFile(`[NSFW FILTER] Blocked domain "${domain}" in: ${url.slice(0, 80)}`);
          return true;
        }
      }

      // Check query for explicit keywords
      for (const keyword of nsfwKeywords) {
        if (lowerQuery.includes(keyword)) {
          logToFile(`[NSFW FILTER] Blocked query keyword "${keyword}" in query: "${query}"`);
          return true;
        }
      }

      // Check URL and title for NSFW keywords (but not common safe words)
      const checkText = `${lowerUrl} ${lowerTitle}`;
      for (const keyword of nsfwKeywords) {
        if (checkText.includes(keyword)) {
          logToFile(`[NSFW FILTER] Blocked keyword "${keyword}" in URL/title`);
          return true;
        }
      }

      return false;
    }

    // Filter out NSFW images
    const safeUrls = imageUrls.filter(item => {
      if (isNSFW(item.url, item.title, query)) return false;
      return true;
    });

    logToFile(`[NSFW FILTER] ${imageUrls.length} → ${safeUrls.length} safe images`);

    // Download images via web fetch (no browser / no CORS issues)
    const downloadedImages: Array<{ imagePath: string; title: string }> = [];

    for (let i = 0; i < Math.min(safeUrls.length, 4); i++) {
      const imgUrl = safeUrls[i].url;
      logToFile(`[IMAGE SEARCH] Downloading image ${i + 1}: ${imgUrl.slice(0, 100)}`);

      try {
        const imgResponse = await fetchWithTimeout(imgUrl, {
          redirect: "follow",
          headers: {
            "User-Agent": FETCH_USER_AGENT,
            Referer: "https://www.bing.com/",
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
        }, 15000);
        if (!imgResponse.ok) {
          logToFile(`[IMAGE SEARCH] Image ${i + 1} HTTP ${imgResponse.status}`);
          continue;
        }
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        if (buffer.length < 1000) {
          logToFile(`[IMAGE SEARCH] Image ${i + 1} too small (${buffer.length} bytes)`);
          continue;
        }
        const tempPath = path.join(imagesDir, `search_${Date.now()}_${i}.jpg`);
        fs.writeFileSync(tempPath, buffer);
        const sizeKB = Math.round(buffer.length / 1024);
        logToFile(`[IMAGE SEARCH] Saved image ${i + 1}: ${tempPath} (${sizeKB}KB)`);
        downloadedImages.push({ imagePath: tempPath, title: safeUrls[i].title || query });
      } catch (err) {
        logToFile(`[IMAGE SEARCH] Image ${i + 1} download error: ${err}`);
      }
    }

    logToFile(`[IMAGE SEARCH] Successfully downloaded ${downloadedImages.length} safe images`);
    return downloadedImages;
  } catch (error) {
    logToFile(`[IMAGE SEARCH ERROR] ${error}`);
    return [];
  }
}

function createMessagePayload(history: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: getSystemPrompt() }, ...cleanHistory(history)];
}

async function debugRawHttpRequest(model: string, payload: ChatMessage[]): Promise<DebugHttpResult | null> {
  const key = MISTRAL_API_KEY || OPENAI_API_KEY;
  if (!key || typeof fetch !== "function") return null;

  const base = MISTRAL_BASE_URL;
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages: payload }),
    });
    const body = await resp.text();
    console.error("[debugRawHttpRequest] url:", url, "status:", resp.status, "body:", body);
    const headers: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: resp.status, body, headers };
  } catch (error) {
    console.error("[debugRawHttpRequest] fetch failed:", error);
    return null;
  }
}

async function createChatResponse(history: ChatMessage[], model: string, maxTokens = 512, temperature = 0.7): Promise<string> {
  const payload = createMessagePayload(history);
  const useMistral = Boolean(MISTRAL_API_KEY || MISTRAL_BASE_URL.includes("mistral"));
  const key = MISTRAL_API_KEY || OPENAI_API_KEY;

  try {
    if (useMistral && key) {
      const url = MISTRAL_BASE_URL.endsWith("/v1") ? `${MISTRAL_BASE_URL}/chat/completions` : `${MISTRAL_BASE_URL}/v1/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: payload, max_tokens: maxTokens, temperature }),
      });

      const text = await response.text();
      const json = parseJson(text);

      if (!response.ok) {
        throw new Error(`Mistral HTTP ${response.status}: ${text}`);
      }

      const choice = json?.choices?.[0];
      const content = choice?.message?.content ?? choice?.text ?? "";
      return String(content).trim();
    }

    const response = await openai.chat.completions.create({
      model,
      messages: payload,
      max_tokens: maxTokens,
      temperature,
    });

    const choice = response?.choices?.[0];
    return choice?.message?.content?.trim() || "";
  } catch (err) {
    const debugInfo = {
      message: err instanceof Error ? err.message : String(err),
      status: err && typeof err === "object" && "status" in err ? (err as any).status : null,
      responseBody: err && typeof err === "object" && "body" in err ? (err as any).body : null,
      requestPayloadSize: JSON.stringify(payload).length,
      model,
    };
    debugLog("ERROR", "Chat completion failed", debugInfo);
    console.error("Chat completion error:", JSON.stringify(debugInfo, null, 2));
    try { await debugRawHttpRequest(model, payload); } catch {}
    throw err;
  }
}

function parseJson(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans, // Added for unban support functionality clarity
    GatewayIntentBits.GuildVoiceStates,
  ]
});

(global as any).discordClientInstance = discord;

(global as any).askAI = async function askAI(prompt: string): Promise<string> {
  const tempHistory: ChatMessage[] = [{ role: "user", content: prompt }];
  const reply = await createChatResponse(tempHistory, RESPONSE_MODEL, 512, 0.5);
  const parsed = extractJsonFromText(reply);
  if (parsed) return `[Action Command]\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  return reply;
};

async function registerSlashCommands(clientId: string, token: string): Promise<void> {
  const guildCommands = [
    new SlashCommandBuilder()
      .setName("send-dm")
      .setDescription("Send a direct message to a user via the bot")
      .addStringOption(option =>
        option.setName("user_id").setDescription("The Discord ID of the user").setRequired(true)
      )
      .addStringOption(option =>
        option.setName("message").setDescription("The message you want to send").setRequired(true)
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder().setName("health-check").setDescription("Check the bot's health and status").toJSON(),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask the AI anything or send a command")
      .addStringOption(option =>
        option.setName("prompt").setDescription("Your question or command for the AI").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder().setName("yobnh-member").setDescription("Verify a yobnh member").toJSON(),
    new SlashCommandBuilder().setName("clearmemory").setDescription("Reset your conversation history with the AI").toJSON(),
    new SlashCommandBuilder()
      .setName("language")
      .setDescription("Change the bot's speaking style (English or OwO)")
      .addStringOption(option =>
        option.setName("mode")
          .setDescription("Pick a style")
          .setRequired(true)
          .addChoices(
            { name: "English", value: "english" },
            { name: "OwO", value: "owo" }
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("update-channel")
      .setDescription("Set a channel to automatically receive new commits from the repo")
      .addChannelOption(option =>
        option.setName("channel").setDescription("The channel to post commit updates to").setRequired(true)
      )
      .addBooleanOption(option =>
        option.setName("disable").setDescription("Turn off automatic commit updates").setRequired(false)
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("send-file")
      .setDescription("Send a file to AuroraSphinx")
      .addAttachmentOption(option =>
        option.setName("file").setDescription("The file you want to send").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("notice-aurora")
      .setDescription("Send a notice to AuroraSphinx")
      .addStringOption(option =>
        option.setName("message").setDescription("Your notice message").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Make YOBNH join the voice channel you are in")
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Make YOBNH leave the voice channel")
      .setDMPermission(false)
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    console.log("Synchronizing slash command arrays...");
    await rest.put(Routes.applicationCommands(clientId), { body: guildCommands });
    console.log("✅ Slash commands registered globally (app commands): /send-dm, /health-check, /ask, /yobnh-member, /update-channel, /clearmemory, /send-file, /notice-aurora, /join, /leave");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}

// --- Self-Update System (pulls latest code from GitHub) ---
async function updateBotFromGitHub(channel: any, requestedBy: string): Promise<void> {
  const send = (text: string) => channel.send(text).catch(() => {});

  try {
    if (!GITHUB_TOKEN) {
      await send("❌ No `GITHUB_TOKEN` configured. Cannot access the private repository.");
      return;
    }

    const headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "yobnh-bot",
    };

    await send("🔎 Checking latest commit on GitHub...");
    const commitResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=1`, { headers });
    if (!commitResp.ok) {
      await send(`❌ GitHub API returned \`${commitResp.status}\`:\n\`\`\`${(await commitResp.text()).slice(0, 500)}\`\`\``);
      return;
    }
    const commits: any[] = await commitResp.json();
    const latest = commits[0];
    if (!latest) {
      await send("❌ No commits found in the repository.");
      return;
    }
    const latestSha = latest.sha;
    const latestMessage = String(latest.commit?.message || "").split("\n")[0];

    let currentSha = "";
    try { currentSha = (await exec("git rev-parse HEAD")).stdout.trim(); } catch {}

    if (currentSha && currentSha === latestSha) {
      await send(`✅ **Already up to date!** Both are on commit \`${latestSha.slice(0, 7)}\``);
      return;
    }

    await send(
      `🔄 **Updating YOBNH from GitHub**\n` +
      `\`\`\`\nRepo:    ${GITHUB_REPO}\n` +
      `Current: ${currentSha ? currentSha.slice(0, 7) : "unknown"}\n` +
      `Latest:  ${latestSha.slice(0, 7)}\n` +
      `Commit:  ${latestMessage}\`\`\``
    );

    await send("⬇️ Downloading latest source...");
    const tarResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tarball/${latestSha}`, { headers });
    if (!tarResp.ok) {
      await send(`❌ Source download failed: \`${tarResp.status}\``);
      return;
    }
    const buffer = Buffer.from(await tarResp.arrayBuffer());

    const tempDir = path.join(os.tmpdir(), `yobnh_update_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const tarPath = path.join(tempDir, "repo.tar.gz");
    fs.writeFileSync(tarPath, buffer);

    await send("📦 Extracting source...");
    await exec(`tar -xzf "${tarPath}" -C "${tempDir}"`, { maxBuffer: 10 * 1024 * 1024 });

    const extractRoot = fs.readdirSync(tempDir).find((entry) => entry.startsWith("AuroraSphinx-yobnh-")) || fs.readdirSync(tempDir)[0];
    const srcDir = path.join(tempDir, extractRoot);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      throw new Error(`Could not find extracted repository folder (got "${extractRoot}")`);
    }

    await send("📝 Replacing source files...");
    const protectedDirs = new Set(["node_modules", ".git", "browser_profile", "images", "images_temps", "community-files"]);
    // Local/runtime files that must survive an update (never delete these)
    const keepFiles = new Set([
      ".env", ".env.local",
      "blacklist.json", "language.json", "update_channel.json",
      "logs.txt", "bot-errors.log", "logs",
    ]);

    const copyTree = (src: string, dest: string): void => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (protectedDirs.has(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          copyTree(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };

    // Remove files in the working copy that no longer exist in the repo, so
    // stale files (e.g. removed playwright configs/tests) never break the build.
    const pruneRemoved = (src: string, dest: string, isRoot: boolean): void => {
      for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
        if (protectedDirs.has(entry.name) || keepFiles.has(entry.name)) continue;
        if (isRoot && entry.name.startsWith(".")) continue;
        if (!fs.existsSync(path.join(src, entry.name))) {
          fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
        }
      }
    };

    pruneRemoved(srcDir, process.cwd(), true);
    copyTree(srcDir, process.cwd());

    await send("📦 Installing dependencies (`npm install`)...");
    await exec("npm install", { cwd: process.cwd(), env: execEnv, timeout: 600000, maxBuffer: 20 * 1024 * 1024 });

    await send("🏗️ Building (`npm run build`)...");
    await exec("npm run build", { cwd: process.cwd(), env: execEnv, timeout: 600000, maxBuffer: 20 * 1024 * 1024 });

    // Restart the web terminal so it also picks up the new code. Plain
    // updates never restarted it, which is why the terminal kept running the
    // old buggy build (crashing on the browser's resize message).
    try {
      const termDir = path.join(process.cwd(), "YOBNH-TERMINAL");
      const restartScript = path.join(termDir, "restart.sh");
      if (fs.existsSync(restartScript)) {
        await send("🔄 Restarting web terminal...");
        await exec(`bash "${restartScript}"`, { cwd: process.cwd(), env: execEnv, timeout: 300000, maxBuffer: 5 * 1024 * 1024 });
        logToFile("[UPDATE] Web terminal restarted");
      }
    } catch (err) {
      logToFile(`[UPDATE] Web terminal restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    logToFile(`[UPDATE] Bot updated to ${latestSha.slice(0, 7)} (${latestMessage}) by ${requestedBy}`);
    conversations.clear();
    await send("✅ **Update complete!** Restarting the bot...");
    restartBot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logToFile(`[UPDATE ERROR] ${msg}`);
    try { await send(`❌ **Update failed:**\n\`\`\`${msg}\`\`\``); } catch {}
  }
}

// --- Auto Update Channel (posts new commits to a channel) ---
const UPDATE_CHANNEL_FILE = path.join(process.cwd(), "update_channel.json");

function loadUpdateChannelConfig(): { channelId: string | null; lastSha: string | null } {
  try {
    if (fs.existsSync(UPDATE_CHANNEL_FILE)) {
      const data = JSON.parse(fs.readFileSync(UPDATE_CHANNEL_FILE, "utf8"));
      return { channelId: data.channelId ?? null, lastSha: data.lastSha ?? null };
    }
  } catch {}
  return { channelId: null, lastSha: null };
}

function saveUpdateChannelConfig(config: { channelId: string | null; lastSha: string | null }): void {
  try {
    fs.writeFileSync(UPDATE_CHANNEL_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

async function fetchLatestCommits(perPage = 10): Promise<any[]> {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=${perPage}`;
  const resp = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "yobnh-bot",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
  return await resp.json();
}

function buildCommitEmbeds(commits: any[]): EmbedBuilder[] {
  return commits.map((c: any) => {
    const authorName = c.commit?.author?.name || c.commit?.committer?.name || "Unknown";
    const authorAvatar = c.author?.avatar_url || null;
    const sha = c.sha.slice(0, 7);
    const fullMessage = String(c.commit?.message || "");
    const [firstLine, ...bodyLines] = fullMessage.split("\n");
    const bodyText = bodyLines.join("\n").replace(/\s+/g, " ").trim();
    const dateStr = c.commit?.author?.date ? new Date(c.commit.author.date).toLocaleString() : "Unknown";

    return new EmbedBuilder()
      .setColor(0x57F287)
      .setAuthor({ name: authorName, iconURL: authorAvatar || undefined })
      .setTitle(firstLine || "(no commit message)")
      .setURL(c.html_url || undefined)
      .setDescription(bodyText.length > 0 ? bodyText.slice(0, 1000) : null)
      .addFields(
        { name: "Commit", value: `\`${sha}\``, inline: true },
        { name: "Date", value: dateStr, inline: true }
      )
      .setTimestamp();
  });
}

async function sendEmbedsToChannel(channelId: string, embeds: EmbedBuilder[]): Promise<void> {
  const target = discord.channels.cache.get(channelId);
  if (!target || !("send" in target)) throw new Error("configured channel is not accessible");
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    await (target as any).send({ embeds: batch });
  }
}

async function postNewCommitsToChannel(channelId: string): Promise<number> {
  const config = loadUpdateChannelConfig();
  const commits = await fetchLatestCommits(10);
  const newCommits: any[] = [];
  for (const c of commits) {
    if (c.sha === config.lastSha) break;
    newCommits.push(c);
  }
  if (!newCommits.length) return 0;
  await sendEmbedsToChannel(channelId, buildCommitEmbeds(newCommits));
  saveUpdateChannelConfig({ channelId, lastSha: newCommits[0].sha });
  return newCommits.length;
}

async function autoPostCommits(): Promise<void> {
  const config = loadUpdateChannelConfig();
  if (!config.channelId) return;
  if (!GITHUB_TOKEN) return;
  try {
    const count = await postNewCommitsToChannel(config.channelId);
    if (count > 0) logToFile(`[UPDATE CHANNEL] Auto-posted ${count} new commit(s).`);
  } catch (err) {
    logToFile(`[UPDATE CHANNEL] Auto-post failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

setInterval(() => { autoPostCommits(); }, 5 * 60 * 1000);
setTimeout(() => { autoPostCommits(); }, 15000);

function restartBot(): void {
  const cwd = process.cwd();
  const modeArg = `--mode=${RUNNING_MODE}`;
  try {
    const launchScript = process.argv[1] || "";
    const isCompiled = /(^|[\\/])dist[\\/]index\.js$/i.test(launchScript);
    const nodePath = process.execPath;
    const npxPath = path.join(NODE_BIN_DIR, "npx");
    const runCmd = isCompiled
      ? `cd "${cwd}" && nohup ${nodePath} dist/index.js ${modeArg} >> logs.txt 2>&1 &`
      : `cd "${cwd}" && PATH="${execEnv.PATH}" nohup ${npxPath} ts-node index.ts ${modeArg} >> logs.txt 2>&1 &`;
    spawn("sh", ["-c", runCmd], { detached: true, stdio: "ignore" }).unref();
    logToFile("[UPDATE] Restart scheduled (linux nohup).");
  } catch (err) {
    logToFile(`[UPDATE] Restart failed: ${err}`);
  }
  setTimeout(() => process.exit(0), 3000).unref();
}

discord.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (isBlacklisted(interaction.user.id)) {
    interaction.reply({ content: "Sorry but you are blacklisted from YOBNH.", ephemeral: true });
    return;
  }

  if (maintenanceMode && interaction.inGuild() && interaction.guildId !== MAINTENANCE_SERVER_ID) {
    interaction.reply({ content: "Sorry, YOBNH is in maintenance mode.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "send-dm") {
    setImmediate(async () => {
      if (!interaction.memberPermissions?.has('Administrator')) {
        await interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
        return;
      }

      const targetId = interaction.options.getString("user_id", true).trim();
      const messageContent = interaction.options.getString("message", true).trim();

      if (isSpamming(targetId)) {
        await interaction.reply({ 
          content: "⚠️ **Rate limit reached!** You are sending too many messages to this user ID right now.", 
          ephemeral: true 
        });
        return;
      }

      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (deferError) {
        return;
      }

      try {
        const targetUser = await discord.users.fetch(targetId, { force: true });
        const dmChannel = await targetUser.createDM();
        await dmChannel.send(messageContent);
        await interaction.editReply({ content: `✅ Successfully sent direct message to **${targetUser.tag}**!` });
      } catch (error: any) {
        console.error("Slash DM Command Error:", error);
        await interaction.editReply({ 
          content: `❌ **Delivery Failed.** This user may have their DMs locked down, or the User ID is invalid.` 
        });
      }
    });
  }

  if (interaction.commandName === "language") {
    setImmediate(async () => {
      const mode = interaction.options.getString("mode", true) as "english" | "owo";
      saveLanguage(mode);
      const label = mode === "owo" ? "OwO" : "English";
      logToFile(`[LANGUAGE] Changed to ${label} by ${interaction.user.tag}`);
      await interaction.reply({ content: `✅ Language set to **${label}**!`, ephemeral: true });
    });
    return;
  }

  if (interaction.commandName === "health-check") {
    setImmediate(async () => {
      try {
        await interaction.deferReply();
      } catch (deferError: any) {
        if (deferError?.code !== 10062) {
          console.error("[DISCORD TIMEOUT] Real connection failure:", deferError);
          return;
        }
      }

      try {
        const stats = await pidusage(process.pid);
        const totalMem = os.totalmem();
        const memUsedPercent = Math.round((stats.memory / totalMem) * 100);
        const cpuPercent = Math.round(stats.cpu);
        const memUsedMB = Math.round(stats.memory / 1024 / 1024);
        const memTotalMB = Math.round(totalMem / 1024 / 1024);
        const uptimeMs = process.uptime() * 1000;
        const uptimeDays = Math.floor(uptimeMs / 86400000);
        const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
        const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
        const uptimeStr = uptimeDays > 0
          ? `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m`
          : uptimeHours > 0
            ? `${uptimeHours}h ${uptimeMinutes}m`
            : `${uptimeMinutes}m`;
        const guildCount = discord.guilds.cache.size;
        const userCount = discord.users.cache.size;
        const pingLatency = discord.ws.ping;
        const conversationCount = conversations.size;

        let healthScore = 0;
        if (cpuPercent < 30) healthScore += 2;
        else if (cpuPercent < 60) healthScore += 1;
        if (memUsedPercent < 50) healthScore += 2;
        else if (memUsedPercent < 75) healthScore += 1;
        if (pingLatency < 100) healthScore += 2;
        else if (pingLatency < 250) healthScore += 1;
        if (!isThrottled) healthScore += 1;

        let healthStatus: string;
        let healthColor: number;
        if (healthScore >= 7) { healthStatus = "Great"; healthColor = 0x00e676; }
        else if (healthScore >= 5) { healthStatus = "Good"; healthColor = 0x66bb6a; }
        else if (healthScore >= 3) { healthStatus = "Mid"; healthColor = 0xffa726; }
        else { healthStatus = "Bad"; healthColor = 0xef5350; }

        const statusIcon = isThrottled ? "Throttled" : "Normal";

        const embed = new EmbedBuilder()
          .setTitle(`${BOT_NAME} ${BOT_VERSION}`)
          .setColor(healthColor)
          .addFields(
            { name: "Status", value: `**${healthStatus}**`, inline: true },
            { name: "Uptime", value: uptimeStr, inline: true },
            { name: "Ping", value: `${pingLatency}ms`, inline: true },
            { name: "CPU Usage", value: `${cpuPercent}%`, inline: true },
            { name: "Memory Usage", value: `${memUsedPercent}% (${memUsedMB}/${memTotalMB} MB)`, inline: true },
            { name: "Run Mode", value: RUNNING_MODE.toUpperCase(), inline: true },
            { name: "Throttle State", value: statusIcon, inline: true },
            { name: "Guilds", value: `${guildCount}`, inline: true },
            { name: "Cached Users", value: `${userCount}`, inline: true },
            { name: "Active Conversations", value: `${conversationCount}`, inline: true },
            { name: "Model", value: `\`${RESPONSE_MODEL || "N/A"}\``, inline: false }
          )
          .setFooter({ text: `Health Score: ${healthScore}/8` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Health check failed:", err);
        try { await interaction.editReply(`Health check failed: ${msg}`); } catch {}
      }
    });
  }

  if (interaction.commandName === "ask") {
    setImmediate(async () => {
      const prompt = interaction.options.getString("prompt", true).trim();

      try {
        await interaction.deferReply();
      } catch (deferError: any) {
        if (deferError?.code !== 10062) {
          console.error("[DISCORD TIMEOUT] Real connection failure:", deferError);
          return;
        }
      }

      try {
        const channelId = interaction.channelId;
        const userId = interaction.user.id;
        addToHistory(channelId, userId, "user", prompt);

        let reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 512, 0.5);
        logToFile(`[ASK AI REPLY] ${reply}`);
        let parsed = extractJsonFromText(reply);

        // Handle array of actions (e.g. [{"action":"search_images","query":"..."}])
        if (Array.isArray(parsed)) {
          logToFile(`[ASK PARSED ARRAY] ${JSON.stringify(parsed)}`);
          const supportedAction = parsed.find((a: any) => ["search_images", "search", "open"].includes(a?.action));
          if (supportedAction) {
            parsed = supportedAction;
            logToFile(`[ASK EXTRACTED ${supportedAction.action}] ${JSON.stringify(parsed)}`);
          }
        }

        if (parsed?.action === "search_images" && parsed.query) {
          logToFile(`[ASK ACTION] search_images: "${parsed.query}"`);
          await interaction.editReply(`🖼️ Searching images for: "${parsed.query}"...\n\n⚠️ **This feature is a work in progress, bugs are expected...**`);
          const imageDataArr = await searchDuckDuckGoImages(parsed.query);
          logToFile(`[ASK IMAGE RESULT] Got ${imageDataArr.length} images`);
          if (imageDataArr.length > 0) {
            try {
              const attachments = imageDataArr.map(img => new AttachmentBuilder(img.imagePath, { name: path.basename(img.imagePath) }));
              await interaction.editReply({ content: `🖼️ **${parsed.query}** (${imageDataArr.length} images)`, files: attachments });
              for (const img of imageDataArr) {
                try { fs.unlinkSync(img.imagePath); } catch {}
              }
            } catch (sendErr) {
              logToFile(`[ASK IMAGE SEND ERROR] ${sendErr}`);
              await interaction.editReply(`⚠️ Found images but failed to send them.`);
            }
          } else {
            await interaction.editReply(`⚠️ I couldn't find any images for "${parsed.query}".`);
          }
          addToHistory(channelId, userId, "assistant", `Searched images for: ${parsed.query}`);
        } else if (parsed?.action === "search" && parsed.query) {
          await interaction.editReply(`🔎 Searching for: "${parsed.query}"...`);
          const results = await searchDuckDuckGo(parsed.query);
          const browserData = results.length
            ? `Search results for "${parsed.query}":\n${results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}`).join("\n\n")}`
            : `No results found.`;
          addToHistory(channelId, userId, "assistant", reply);
          addToHistory(channelId, userId, "user", `Browser results:\n${browserData}`);
          reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 1024, 0.5);
          addToHistory(channelId, userId, "assistant", reply);
          const chunks = splitMessage(reply, 2000);
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
        } else if (parsed?.action === "open" && parsed.url) {
          const cleaned = sanitizeUrl(String(parsed.url));
          if (!cleaned) {
            await interaction.editReply("⚠️ Invalid URL.");
          } else {
            await interaction.editReply(`🌐 Opening: ${cleaned}`);
            try {
              const page = await browseUrl(cleaned, false, 1280, 720);
              addToHistory(channelId, userId, "assistant", reply);
              addToHistory(channelId, userId, "user", `Browser results:\nOpened page: ${page.title}\nURL: ${page.url}\n\n${page.content}`);
              reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 1024, 0.5);
              addToHistory(channelId, userId, "assistant", reply);
              const chunks = splitMessage(reply, 2000);
              await interaction.editReply(chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp(chunks[i]);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await interaction.editReply(`⚠️ Failed to open: ${msg}`);
            }
          }
        } else {
          addToHistory(channelId, userId, "assistant", reply);
          const chunks = splitMessage(reply, 2000);
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Ask command failed:", err);
        try { await interaction.editReply(`Ask failed: ${msg}`); } catch {}
      }
    });
  }

  if (interaction.commandName === "yobnh-member") {
    interaction.reply("YOBNH SHOULD BE VERIFIED NOW");
  }

  if (interaction.commandName === "clearmemory") {
    const key = `${interaction.channelId}-${interaction.user.id}`;
    conversations.delete(key);
    interaction.reply({ content: "✅ Your conversation history has been cleared.", ephemeral: true });
  }

  if (interaction.commandName === "update-channel") {
    setImmediate(async () => {
      if (!interaction.memberPermissions?.has('Administrator')) {
        await interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
        return;
      }

      try {
        await interaction.deferReply();
      } catch (deferError: any) {
        if (deferError?.code !== 10062) {
          console.error("[DISCORD TIMEOUT] Real connection failure:", deferError);
          return;
        }
      }

      const disable = interaction.options.getBoolean("disable") ?? false;

      if (disable) {
        saveUpdateChannelConfig({ channelId: null, lastSha: null });
        await interaction.editReply({ content: "✅ Automatic commit updates are now **disabled**." });
        return;
      }

      const targetChannel = interaction.options.getChannel("channel", true);

      if (!GITHUB_TOKEN) {
        const failEmbed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle("❌ Commit Fetch Failed")
          .setDescription("No `GITHUB_TOKEN` environment variable is set. Cannot access the private repository.")
          .setTimestamp();
        await interaction.editReply({ embeds: [failEmbed] });
        return;
      }

      try {
        const config = loadUpdateChannelConfig();
        saveUpdateChannelConfig({ channelId: targetChannel.id, lastSha: config.lastSha });

        const commits = await fetchLatestCommits(10);

        if (!commits.length) {
          saveUpdateChannelConfig({ channelId: targetChannel.id, lastSha: null });
          await interaction.editReply({ content: `✅ Automatic commit updates **enabled** in <#${targetChannel.id}>. The repo currently has no commits.` });
          return;
        }

        await sendEmbedsToChannel(targetChannel.id, buildCommitEmbeds(commits));
        saveUpdateChannelConfig({ channelId: targetChannel.id, lastSha: commits[0].sha });
        await interaction.editReply({ content: `✅ Automatic commit updates **enabled** in <#${targetChannel.id}>. Posted the latest **${commits.length}** commit(s); new commits will be auto-posted every 5 minutes.` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const config = loadUpdateChannelConfig();
        saveUpdateChannelConfig({ channelId: targetChannel.id, lastSha: config.lastSha });
        const failEmbed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle("❌ Commit Fetch Failed")
          .setDescription(`Channel was saved, but fetching commits failed:\n\`\`\`${msg}\`\`\``)
          .setTimestamp();
        try { await interaction.editReply({ embeds: [failEmbed] }); } catch {}
      }
    });
  }

  if (interaction.commandName === "send-file") {
    setImmediate(async () => {
      try {
        await interaction.deferReply();
      } catch {
        logToFile("[FILE ERROR] Failed to defer reply for send-file");
        return;
      }

      let tmpPath = "";
      try {
        const attachment = interaction.options.getAttachment("file", true);

        const targetDir = path.join(process.cwd(), "community-files", "files-sent");
        fs.mkdirSync(targetDir, { recursive: true });

        const originalName = attachment.name;
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);
        const timestamp = Date.now();
        const safeName = `${baseName}_${timestamp}${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
        tmpPath = path.join(os.tmpdir(), `yobnh_file_${timestamp}${ext}`);
        const savePath = path.join(targetDir, safeName);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        const response = await fetch(attachment.url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) throw new Error(`HTTP ${response.status} fetching attachment`);

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(tmpPath, buffer);

        fs.copyFileSync(tmpPath, savePath);
        try { fs.unlinkSync(tmpPath); } catch {}
        logToFile(`[FILE] Saved "${safeName}" from ${interaction.user.tag} (${interaction.user.id})`);

        if (OWNER_ID) {
          try {
            const owner = await discord.users.fetch(OWNER_ID);
            const source = interaction.guild
              ? `**Server:** ${interaction.guild.name}\n**Channel:** <#${interaction.channelId}>`
              : "**Source:** Direct Messages";
            await owner.send({
              content: `📁 **File received!**\n**From:** ${interaction.user.tag} (\`${interaction.user.id}\`)\n**File:** \`${safeName}\`\n${source}`
            });
          } catch {}
        }

        await interaction.editReply({ content: `✅ File saved as \`${safeName}\`` });
      } catch (err) {
        logToFile(`[FILE ERROR] Failed to save file from ${interaction.user.tag}: ${err}`);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        try { await interaction.editReply({ content: "❌ Failed to save the file. Try again later." }); } catch {}
      }
    });
  }

  if (interaction.commandName === "notice-aurora") {
    setImmediate(async () => {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {}

      const msgContent = interaction.options.getString("message", true);

      if (!OWNER_ID) {
        await interaction.editReply({ content: "❌ Bot owner is not configured yet." });
        return;
      }

      try {
        const owner = await discord.users.fetch(OWNER_ID);
        const channelName = interaction.channel?.isDMBased()
          ? "Direct Messages"
          : `#${(interaction.channel as any)?.name || "unknown"}`;
        const guildName = interaction.guild?.name || "Direct Messages";
        const messageLink = interaction.channel?.isDMBased()
          ? `https://discord.com/channels/@me/${interaction.channelId}`
          : `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("Notice from Aurora")
          .setDescription(msgContent)
          .addFields(
            { name: "From", value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: true },
            { name: "Server", value: guildName, inline: true },
            { name: "Channel", value: channelName, inline: true }
          )
          .setTimestamp();

        await owner.send({ content: messageLink, embeds: [embed] });

        await interaction.editReply({ content: "✅ Your notice has been sent to AuroraSphinx!" });
      } catch (err) {
        logToFile(`[NOTICE ERROR] Failed to send notice from ${interaction.user.tag}: ${err}`);
        await interaction.editReply({ content: "❌ Failed to send the notice. The owner may have DMs disabled." });
      }
    });
  }

  if (interaction.commandName === "join") {
    setImmediate(async () => {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
        return;
      }
      const member = interaction.member;
      const targetChannel = member?.voice?.channel;
      if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: "❌ You are not in VC!", ephemeral: true });
        return;
      }
      try {
        joinVoiceChannel({
          channelId: targetChannel.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator as any,
        });
        logToFile(`[VOICE] ${interaction.user.tag} (${interaction.user.id}) made YOBNH join ${targetChannel.name}`);
        await interaction.reply({ content: `🔊 Joined **${targetChannel.name}**!` });
      } catch (err: any) {
        await interaction.reply({ content: `❌ Failed to join the voice channel: ${err?.message || err}`, ephemeral: true });
      }
    });
    return;
  }

  if (interaction.commandName === "leave") {
    setImmediate(async () => {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
        return;
      }
      const connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        await interaction.reply({ content: "❌ I'm not in a voice channel in this server.", ephemeral: true });
        return;
      }
      connection.destroy();
      logToFile(`[VOICE] ${interaction.user.tag} (${interaction.user.id}) made YOBNH leave voice`);
      await interaction.reply({ content: "👋 Left the voice channel!" });
    });
    return;
  }
});

discord.once(Events.ClientReady, async (client) => {
  logToFile(`[BOT] Logged in as ${client.user.tag}`);
  logToFile(`[BOT] Guilds: ${client.guilds.cache.size}`);
  logToFile(`[BOT] Prefix: "${PREFIX}"`);

  try {
    await client.user.setPresence({
      status: PresenceUpdateStatus.Online,
      activities: [{ name: `${BOT_NAME} ${BOT_VERSION}`, type: ActivityType.Custom }],
    });
  } catch (err) {
    console.error("Failed to set bot presence:", err);
  }

  try {
    const app = await client.application!.fetch();
    if (app.owner) {
      if (app.owner instanceof Team) {
        OWNER_ID = app.owner.members.first()?.id ?? "";
      } else {
        OWNER_ID = (app.owner as any).id;
      }
      logToFile(`[BOT] Owner ID: ${OWNER_ID}`);
    }
  } catch (err) {
    console.error("Failed to fetch bot owner:", err);
  }

  try {
    await registerSlashCommands(client.user.id, DISCORD_TOKEN);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

async function executeSingleAction(parsed: any, channel: any, userId: string, channelId: string): Promise<void> {
  if (parsed?.action === "kick" && parsed.user) {
    const userQuery = String(parsed.user);
    const reason = parsed.reason || "No explicit reason provided.";
    
    if (channel.guild && !channel.guild.members.me?.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      const permErr = "Aborted: I do not possess Kick Members permissions in this guild layout setup.";
      await channel.send(`❌ ${permErr}`);
      addToHistory(channelId, userId, "assistant", permErr);
      return;
    }

    await channel.send(`kick ${userQuery}...`);
    try {
      const member = channel.guild?.members.cache.get(userQuery) || channel.guild?.members.cache.find((m: any) => m.user.username.toLowerCase() === userQuery.toLowerCase());
      if (!member) throw new Error("User was not found in the target server cache framework workspace.");
      await member.kick(reason);
      await channel.send(`Kicked ${member.user.username}!`);
      addToHistory(channelId, userId, "assistant", `Successfully kicked user ${member.user.username}`);
    } catch (err: any) {
      await channel.send(`❌ Kick Action execution aborted: ${err.message}`);
      addToHistory(channelId, userId, "assistant", `Failed to kick user: ${err.message}`);
    }
  }

  if (parsed?.action === "timeout" && parsed.user) {
    const userQuery = String(parsed.user);
    const durationSec = Number(parsed.duration || 600);
    const reason = parsed.reason || "No explicit reason provided.";

    if (channel.guild && !channel.guild.members.me?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      const permErr = "Aborted: I do not possess Moderate Members (Timeout) permissions in this guild layout setup.";
      await channel.send(`❌ ${permErr}`);
      addToHistory(channelId, userId, "assistant", permErr);
      return;
    }

    await channel.send(`timeout ${userQuery}...`);
    try {
      const member = channel.guild?.members.cache.get(userQuery) || channel.guild?.members.cache.find((m: any) => m.user.username.toLowerCase() === userQuery.toLowerCase());
      if (!member) throw new Error("User was not found in the target server cache framework workspace.");
      await member.timeout(durationSec * 1000, reason);
      await channel.send(`Timeouted ${member.user.username}!`);
      addToHistory(channelId, userId, "assistant", `Timeouted user ${member.user.username} for ${durationSec} seconds.`);
    } catch (err: any) {
      await channel.send(`❌ Timeout Action execution aborted: ${err.message}`);
      addToHistory(channelId, userId, "assistant", `Failed to timeout user: ${err.message}`);
    }
  }

  // --- Untimeout Implementation ---
  if (parsed?.action === "untimeout" && parsed.user) {
    const userQuery = String(parsed.user).trim();
    const reason = parsed.reason || "No explicit reason provided.";

    if (channel.guild && !channel.guild.members.me?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      const permErr = "Aborted: I do not possess Moderate Members permissions to remove timeout.";
      await channel.send(`❌ ${permErr}`);
      addToHistory(channelId, userId, "assistant", permErr);
      return;
    }

    try {
      const member = channel.guild?.members.cache.get(userQuery) || channel.guild?.members.cache.find((m: any) => m.user.username.toLowerCase() === userQuery.toLowerCase() || m.user.id === userQuery);
      if (!member) throw new Error("User was not found in the target server cache framework workspace.");
      
      await member.timeout(null, reason);
      await channel.send(`✅ Successfully removed timeout for **${member.user.username}**!`);
      addToHistory(channelId, userId, "assistant", `Successfully removed timeout for user ${member.user.username}.`);
    } catch (err: any) {
      await channel.send(`❌ Untimeout Action execution aborted: ${err.message}`);
      addToHistory(channelId, userId, "assistant", `Failed to remove timeout: ${err.message}`);
    }
  }

  if (parsed?.action === "ban" && parsed.user) {
    const userQuery = String(parsed.user).trim();
    const reason = parsed.reason || "No explicit reason provided.";

    if (channel.guild && !channel.guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      const permErr = "Aborted: I do not possess Ban Members permissions in this guild setup.";
      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`❌ ${permErr}`);
      await channel.send({ embeds: [errEmbed] });
      addToHistory(channelId, userId, "assistant", permErr);
      return;
    }

    // Phase 1: Post initial loading status message update
    const loadingEmbed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setDescription(`⏳ **Banning** \`${userQuery}\`...\n\n*making actions*`);
    const statusMessage = await channel.send({ embeds: [loadingEmbed] });

    try {
      // Look up target member or resolve directly from user object configurations
      const member = channel.guild?.members.cache.get(userQuery) || channel.guild?.members.cache.find((m: any) => m.user.username.toLowerCase() === userQuery.toLowerCase() || m.user.id === userQuery);
      let targetUserObj: any = null;

      if (member) {
        targetUserObj = member.user;
        if (!member.bannable) throw new Error("This member has a higher role hierarchy or permissions rank than me.");
        await member.ban({ reason });
      } else {
        targetUserObj = await discord.users.fetch(userQuery).catch(() => null);
        await channel.guild?.members.ban(userQuery, { reason });
      }

      // Add dramatic processing delay space layout simulation
      await new Promise(resolve => setTimeout(resolve, 1200));

      const targetTag = targetUserObj ? targetUserObj.tag : userQuery;
      const targetId = targetUserObj ? targetUserObj.id : userQuery;
      const pfpUrl = targetUserObj ? targetUserObj.displayAvatarURL({ size: 256 }) : discord.user?.displayAvatarURL();

      // Phase 2: Success state display block complete with user avatar attachment mapping
      const successEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🔨 Ban Confirmation Logged')
        .setDescription(`**Banned!** \`${targetTag}\``)
        .setThumbnail(pfpUrl)
        .addFields(
          { name: '👤 Target ID', value: `\`${targetId}\``, inline: true },
          { name: '📝 Reason Given', value: `\`\`\`${reason}\`\`\`` }
        )
        .setTimestamp();

      await statusMessage.edit({ embeds: [successEmbed] });
      addToHistory(channelId, userId, "assistant", `Successfully banned user: ${targetTag} (${targetId})`);

    } catch (err: any) {
      const failEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`❌ **Ban Action execution aborted:** ${err.message}`);
      await statusMessage.edit({ embeds: [failEmbed] });
      addToHistory(channelId, userId, "assistant", `Failed to ban target: ${err.message}`);
    }
  }

  // --- Embed-based Unban Implementation ---
  if (parsed?.action === "unban" && parsed.user) {
    const userQuery = String(parsed.user).trim();
    const reason = parsed.reason || "No explicit reason provided.";

    if (channel.guild && !channel.guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      const permErr = "Aborted: I do not possess Ban Members permissions to process unban request.";
      const errEmbed = new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${permErr}`);
      await channel.send({ embeds: [errEmbed] });
      addToHistory(channelId, userId, "assistant", permErr);
      return;
    }

    const loadingEmbed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setDescription(`⏳ **Unbanning** \`${userQuery}\`...`);
    const statusMessage = await channel.send({ embeds: [loadingEmbed] });

    try {
      await channel.guild?.members.unban(userQuery, reason);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const successEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🕊️ Unban Confirmation Logged')
        .setDescription(`**Unbanned User ID:** \`${userQuery}\``)
        .addFields({ name: '📝 Reason Given', value: `\`\`\`${reason}\`\`\`` })
        .setTimestamp();

      await statusMessage.edit({ embeds: [successEmbed] });
      addToHistory(channelId, userId, "assistant", `Successfully unbanned user ID: ${userQuery}`);
    } catch (err: any) {
      const failEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`❌ **Unban Action execution aborted:** ${err.message}`);
      await statusMessage.edit({ embeds: [failEmbed] });
      addToHistory(channelId, userId, "assistant", `Failed to unban user ID ${userQuery}: ${err.message}`);
    }
  }

  if (parsed?.action === "search_images" && parsed.query) {
    try {
      await channel.send(`🖼️ Searching images for: "${parsed.query}"...`);
      const imageDataArr = await searchDuckDuckGoImages(parsed.query);
      if (imageDataArr.length > 0) {
        const attachments = imageDataArr.map(img => new AttachmentBuilder(img.imagePath, { name: path.basename(img.imagePath) }));
        await channel.send({ content: `🖼️ **${imageDataArr[0].title || parsed.query}** (${imageDataArr.length} images)`, files: attachments });
        for (const img of imageDataArr) {
          try { fs.unlinkSync(img.imagePath); } catch {}
        }
      } else {
        await channel.send(`⚠️ I couldn't find any images for "${parsed.query}".`);
      }
      addToHistory(channelId, userId, "assistant", `Searched images for: ${parsed.query}`);
    } catch (err) {
      await channel.send(`⚠️ Image search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const handledActions = ["kick", "timeout", "untimeout", "ban", "unban", "search_images"];
  if (!parsed || typeof parsed !== "object" || !handledActions.includes(parsed.action)) {
    await channel.send(`⚠️ I don't have the "${parsed?.action || "that"}" ability anymore, so I couldn't do that. Try describing what you want instead.`);
    addToHistory(channelId, userId, "assistant", `Action "${parsed?.action || "unknown"}" is no longer supported.`);
  }
}

async function performSearchAction(query: string, channel: any): Promise<string | null> {
  if (typeof channel.sendTyping === "function") await channel.sendTyping();
  try {
    await channel.send(`🔎 Searching for: "${query}"...`);
    const results = await searchDuckDuckGo(query);
    return results.length
      ? `Search results for "${query}":\n${results
          .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
          .join("\n\n")}`
      : `No DuckDuckGo results found for "${query}".`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
    return null;
  }
}

async function performOpenAction(parsed: any, channel: any, userText: string): Promise<string | null> {
  const rawUrl = String(parsed.url);
  const cleaned = sanitizeUrl(rawUrl);
  let browserData: string | null = null;

  if (!cleaned) {
    await channel.send("⚠️ The assistant returned an invalid URL to open. Please provide a valid `https://...` URL.");
  } else if (/duckduckgo\.com/i.test(cleaned)) {
    let ddgQuery = userText;
    try { ddgQuery = new URL(cleaned).searchParams.get("q") || userText; } catch {}
    if (typeof channel.sendTyping === "function") await channel.sendTyping();
    try {
      await channel.send(`🔎 Searching for: "${ddgQuery}"...`);
      const results = await searchDuckDuckGo(ddgQuery);
      browserData = results.length
        ? `Search results for "${ddgQuery}":\n${results
            .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
            .join("\n\n")}`
        : `No DuckDuckGo results found for "${ddgQuery}".`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
    }
  } else {
    if (typeof channel.sendTyping === "function") await channel.sendTyping();
    try {
      await channel.send(`🌐 Fetching: ${cleaned}`);
      const page = await browseUrl(cleaned);
      browserData = `Opened page: ${page.title}\nURL: ${page.url}\n\n${page.content}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.send(`⚠️ I failed to fetch the page: ${msg}.`);
    }
  }
  return browserData;
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  if (isBlacklisted(message.author.id)) {
    await message.reply("Sorry but you are blacklisted from YOBNH.");
    return;
  }

  if (isThrottled) {
    await message.reply("⚠️ **Performance Safety Intercept:** The system load usage is currently too high right now! Cooling down... please wait a moment.");
    return;
  }

  const isDM = !message.guild;
  let userText = isDM ? message.content.trim() : message.content.replace(/<@!?(\d+)>/g, "").trim();
  const hasPrefix = userText.startsWith(PREFIX);

  if (!isDM && !hasPrefix && (!discord.user || !message.mentions.has(discord.user))) return;

  if (isSpamming(message.author.id)) {
    return;
  }

  const channel = message.channel as any;

  let prefixCommand: string | null = null;
  let parts: string[] = [];
  if (hasPrefix) {
    const rest = userText.slice(PREFIX.length).trim();
    parts = rest.split(/\s+/);
    prefixCommand = (parts.shift() || "").toLowerCase();
    userText = rest;
  }

  if (!userText) {
    await message.reply("Hi! What can I do for you today?");
    return;
  }

  if (maintenanceMode && (isDM || message.guild.id !== MAINTENANCE_SERVER_ID)) {
    const ownerToggle = prefixCommand === "maintenance" && isOwner(message.author.id);
    if (!ownerToggle) {
      await message.reply("Sorry, YOBNH is in maintenance mode.");
      return;
    }
  }

  if (prefixCommand === "maintenance") {
    if (!isOwner(message.author.id)) {
      await message.reply("❌ Only the bot owner can use `maintenance`.");
      return;
    }
    const arg = (message.content.slice(PREFIX.length).trim().split(/\s+/)[1] || "").toLowerCase();
    if (arg === "on") maintenanceMode = true;
    else if (arg === "off") maintenanceMode = false;
    else maintenanceMode = !maintenanceMode;
    await channel.send(
      maintenanceMode
        ? `🔧 **Maintenance mode is now ON.** YOBNH will only work in <#${MAINTENANCE_SERVER_ID}>.`
        : "✅ **Maintenance mode is now OFF.** YOBNH works everywhere again."
    );
    return;
  }

  if (prefixCommand === "update") {
    const isAdmin = (message.member as any)?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner(message.author.id) && !isAdmin) {
      await message.reply("❌ Only the bot owner or server admins can use `update`.");
      return;
    }
    await channel.send(`🔄 **Yobnh Update** requested by ${message.author.username}...`);
    await updateBotFromGitHub(channel, message.author.username);
    return;
  }

  if (prefixCommand === "ping") {
    const sent = await message.reply("🏓 Pinging...");
    const roundtrip = sent.createdTimestamp - message.createdTimestamp;
    const wsPing = typeof discord.ws?.ping === "number" ? discord.ws.ping : "N/A";
    await sent.edit(`🏓 **Pong!**\nWebSocket: \`${wsPing}ms\`\nRoundtrip: \`${roundtrip}ms\``);
    return;
  }

  if (prefixCommand === "ask") {
    userText = parts.join(" ").trim();
    if (!userText) {
      await message.reply("❌ Usage: `&ask <prompt>`");
      return;
    }
  }

  if (prefixCommand === "clearmemory") {
    const key = `${message.channel.id}-${message.author.id}`;
    conversations.delete(key);
    await message.reply("✅ Your conversation history has been cleared.");
    return;
  }

  if (prefixCommand === "yobnh-member") {
    await message.reply("YOBNH SHOULD BE VERIFIED NOW");
    return;
  }

  if (prefixCommand === "language") {
    const mode = (parts[0] || "").toLowerCase();
    if (mode !== "english" && mode !== "owo") {
      await message.reply("❌ Usage: `&language english` or `&language owo`.");
      return;
    }
    saveLanguage(mode as "english" | "owo");
    const label = mode === "owo" ? "OwO" : "English";
    logToFile(`[LANGUAGE] Changed to ${label} by ${message.author.tag}`);
    await message.reply(`✅ Language set to **${label}**!`);
    return;
  }

  if (prefixCommand === "health-check") {
    try {
      const stats = await pidusage(process.pid);
      const totalMem = os.totalmem();
      const memUsedPercent = Math.round((stats.memory / totalMem) * 100);
      const cpuPercent = Math.round(stats.cpu);
      const memUsedMB = Math.round(stats.memory / 1024 / 1024);
      const memTotalMB = Math.round(totalMem / 1024 / 1024);
      const uptimeMs = process.uptime() * 1000;
      const uptimeDays = Math.floor(uptimeMs / 86400000);
      const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
      const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
      const uptimeStr = uptimeDays > 0
        ? `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m`
        : uptimeHours > 0
          ? `${uptimeHours}h ${uptimeMinutes}m`
          : `${uptimeMinutes}m`;
      const guildCount = discord.guilds.cache.size;
      const userCount = discord.users.cache.size;
      const pingLatency = discord.ws.ping;
      const conversationCount = conversations.size;

      let healthScore = 0;
      if (cpuPercent < 30) healthScore += 2;
      else if (cpuPercent < 60) healthScore += 1;
      if (memUsedPercent < 50) healthScore += 2;
      else if (memUsedPercent < 75) healthScore += 1;
      if (pingLatency < 100) healthScore += 2;
      else if (pingLatency < 250) healthScore += 1;
      if (!isThrottled) healthScore += 1;

      let healthStatus: string;
      let healthColor: number;
      if (healthScore >= 7) { healthStatus = "Great"; healthColor = 0x00e676; }
      else if (healthScore >= 5) { healthStatus = "Good"; healthColor = 0x66bb6a; }
      else if (healthScore >= 3) { healthStatus = "Mid"; healthColor = 0xffa726; }
      else { healthStatus = "Bad"; healthColor = 0xef5350; }

      const statusIcon = isThrottled ? "Throttled" : "Normal";

      const embed = new EmbedBuilder()
        .setTitle(`${BOT_NAME} ${BOT_VERSION}`)
        .setColor(healthColor)
        .addFields(
          { name: "Status", value: `**${healthStatus}**`, inline: true },
          { name: "Uptime", value: uptimeStr, inline: true },
          { name: "Ping", value: `${pingLatency}ms`, inline: true },
          { name: "CPU Usage", value: `${cpuPercent}%`, inline: true },
          { name: "Memory Usage", value: `${memUsedPercent}% (${memUsedMB}/${memTotalMB} MB)`, inline: true },
          { name: "Run Mode", value: RUNNING_MODE.toUpperCase(), inline: true },
          { name: "Throttle State", value: statusIcon, inline: true },
          { name: "Guilds", value: `${guildCount}`, inline: true },
          { name: "Cached Users", value: `${userCount}`, inline: true },
          { name: "Active Conversations", value: `${conversationCount}`, inline: true },
          { name: "Model", value: `\`${RESPONSE_MODEL || "N/A"}\``, inline: false }
        )
        .setFooter({ text: `Health Score: ${healthScore}/8` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Health check failed:", err);
      await channel.send(`Health check failed: ${msg}`);
    }
    return;
  }

  if (prefixCommand === "join") {
    if (isDM) {
      await message.reply("❌ This command only works in a server.");
      return;
    }
    const targetChannel = (message.member as any)?.voice?.channel;
    if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
      await message.reply("❌ You are not in VC!");
      return;
    }
    try {
      joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: message.guild!.id,
        adapterCreator: message.guild!.voiceAdapterCreator as any,
      });
      logToFile(`[VOICE] ${message.author.tag} (${message.author.id}) made YOBNH join ${targetChannel.name}`);
      await channel.send(`🔊 Joined **${targetChannel.name}**!`);
    } catch (err: any) {
      await channel.send(`❌ Failed to join the voice channel: ${err?.message || err}`);
    }
    return;
  }

  if (prefixCommand === "leave") {
    if (isDM) {
      await message.reply("❌ This command only works in a server.");
      return;
    }
    const connection = getVoiceConnection(message.guild!.id);
    if (!connection) {
      await message.reply("❌ I'm not in a voice channel in this server.");
      return;
    }
    connection.destroy();
    logToFile(`[VOICE] ${message.author.tag} (${message.author.id}) made YOBNH leave voice`);
    await channel.send("👋 Left the voice channel!");
    return;
  }

  if (prefixCommand === "send-dm") {
    const isAdmin = (message.member as any)?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner(message.author.id) && !isAdmin) {
      await message.reply("❌ Only admins can use `send-dm`.");
      return;
    }
    const targetId = parts[0]?.trim();
    const dmMessage = parts.slice(1).join(" ").trim();
    if (!targetId || !dmMessage) {
      await message.reply("❌ Usage: `&send-dm <user_id> <message>`");
      return;
    }
    try {
      const targetUser = await discord.users.fetch(targetId, { force: true });
      const dmChannel = await targetUser.createDM();
      await dmChannel.send(dmMessage);
      await message.reply(`✅ Successfully sent direct message to **${targetUser.tag}**!`);
    } catch (err) {
      console.error("Prefix DM Command Error:", err);
      await message.reply(`❌ **Delivery Failed.** This user may have their DMs locked down, or the User ID is invalid.`);
    }
    return;
  }

  if (prefixCommand === "notice-aurora") {
    const msgContent = parts.join(" ").trim();
    if (!msgContent) {
      await message.reply("❌ Usage: `&notice-aurora <message>`");
      return;
    }
    if (!OWNER_ID) {
      await message.reply("❌ Bot owner is not configured yet.");
      return;
    }
    try {
      const owner = await discord.users.fetch(OWNER_ID);
      const channelName = isDM ? "Direct Messages" : `#${(message.channel as any)?.name || "unknown"}`;
      const guildName = message.guild?.name || "Direct Messages";
      const messageLink = isDM
        ? `https://discord.com/channels/@me/${message.channel.id}`
        : `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("Notice from Aurora")
        .setDescription(msgContent)
        .addFields(
          { name: "From", value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
          { name: "Server", value: guildName, inline: true },
          { name: "Channel", value: channelName, inline: true }
        )
        .setTimestamp();

      await owner.send({ content: messageLink, embeds: [embed] });
      await message.reply("✅ Your notice has been sent to AuroraSphinx!");
    } catch (err) {
      logToFile(`[NOTICE ERROR] Failed to send notice from ${message.author.tag}: ${err}`);
      await message.reply("❌ Failed to send the notice. The owner may have DMs disabled.");
    }
    return;
  }

  if (prefixCommand === "update-channel") {
    const isAdmin = (message.member as any)?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner(message.author.id) && !isAdmin) {
      await message.reply("❌ Only admins can use `update-channel`.");
      return;
    }
    const disable = parts.includes("disable") || parts.includes("off");
    if (disable) {
      saveUpdateChannelConfig({ channelId: null, lastSha: null });
      await channel.send("✅ Automatic commit updates are now **disabled**.");
      return;
    }
    const targetId = (parts[0] || "").replace(/[<#>]/g, "");
    if (!targetId) {
      await message.reply("❌ Usage: `&update-channel <#channel> [disable]`");
      return;
    }
    if (!GITHUB_TOKEN) {
      await channel.send("❌ No `GITHUB_TOKEN` environment variable is set. Cannot access the private repository.");
      return;
    }
    try {
      const config = loadUpdateChannelConfig();
      saveUpdateChannelConfig({ channelId: targetId, lastSha: config.lastSha });
      const commits = await fetchLatestCommits(10);
      if (!commits.length) {
        saveUpdateChannelConfig({ channelId: targetId, lastSha: null });
        await channel.send(`✅ Automatic commit updates **enabled** in <#${targetId}>. The repo currently has no commits.`);
        return;
      }
      await sendEmbedsToChannel(targetId, buildCommitEmbeds(commits));
      saveUpdateChannelConfig({ channelId: targetId, lastSha: commits[0].sha });
      await channel.send(`✅ Automatic commit updates **enabled** in <#${targetId}>. Posted the latest **${commits.length}** commit(s); new commits will be auto-posted every 5 minutes.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const config = loadUpdateChannelConfig();
      saveUpdateChannelConfig({ channelId: targetId, lastSha: config.lastSha });
      await channel.send(`❌ **Commit Fetch Failed.** Channel was saved, but fetching commits failed:\n\`\`\`${msg}\`\`\``);
    }
    return;
  }

  if (prefixCommand === "send-file") {
    const attachment = message.attachments.first();
    if (!attachment) {
      await message.reply("❌ Usage: `&send-file` with an attached file.");
      return;
    }
    let tmpPath = "";
    try {
      const targetDir = path.join(process.cwd(), "community-files", "files-sent");
      fs.mkdirSync(targetDir, { recursive: true });
      const originalName = attachment.name;
      const ext = path.extname(originalName);
      const baseName = path.basename(originalName, ext);
      const timestamp = Date.now();
      const safeName = `${baseName}_${timestamp}${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      tmpPath = path.join(os.tmpdir(), `yobnh_file_${timestamp}${ext}`);
      const savePath = path.join(targetDir, safeName);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const response = await fetch(attachment.url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status} fetching attachment`);

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      fs.copyFileSync(tmpPath, savePath);
      try { fs.unlinkSync(tmpPath); } catch {}
      logToFile(`[FILE] Saved "${safeName}" from ${message.author.tag} (${message.author.id})`);

      if (OWNER_ID) {
        try {
          const owner = await discord.users.fetch(OWNER_ID);
          const source = message.guild
            ? `**Server:** ${message.guild.name}\n**Channel:** <#${message.channel.id}>`
            : "**Source:** Direct Messages";
          await owner.send({
            content: `📁 **File received!**\n**From:** ${message.author.tag} (\`${message.author.id}\`)\n**File:** \`${safeName}\`\n${source}`
          });
        } catch {}
      }

      await message.reply(`✅ File saved as \`${safeName}\``);
    } catch (err) {
      logToFile(`[FILE ERROR] Failed to save file from ${message.author.tag}: ${err}`);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      await message.reply("❌ Failed to save the file. Try again later.");
    }
    return;
  }

  logToFile(`[MSG] ${message.author.tag} (${message.author.id}): ${userText}`);

  if (typeof channel.sendTyping === "function") await channel.sendTyping();
  const channelId = message.channel.id;
  const userId = message.author.id;
  addToHistory(channelId, userId, "user", userText);

  let reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 256, 0.4);
  logToFile(`[AI REPLY] ${reply}`);
  let parsed = extractJsonFromText(reply);

  if (parsed) {
    logToFile(`[PARSED ACTION] ${JSON.stringify(parsed)}`);
    addToHistory(channelId, userId, "assistant", reply);

    const items = (Array.isArray(parsed) ? parsed : [parsed]).filter((item: any) => item && typeof item === "object");
    let browserData: string | null = null;
    let needsFollowUp = false;

    for (const item of items) {
      const action = item?.action;
      if (action === "search" && item.query) {
        needsFollowUp = true;
        const data = await performSearchAction(item.query, channel);
        if (data) browserData = data;
      } else if (action === "open" && item.url) {
        needsFollowUp = true;
        const data = await performOpenAction(item, channel, userText);
        if (data) browserData = data;
      } else {
        await executeSingleAction(item, channel, userId, channelId);
      }
    }

    if (needsFollowUp) {
      if (browserData) {
        addToHistory(channelId, userId, "user", `Browser results:\n${browserData}\n\nPlease answer the original question using this information.`);
        reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 1024, 0.5);
      }
      addToHistory(channelId, userId, "assistant", reply);
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
    return;
  }

  addToHistory(channelId, userId, "assistant", reply);

  const chunks = splitMessage(reply, 2000);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

discord.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(message);
  } catch (error) {
    logToFile(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ""}`);
    const errorPayload = {
      type: "ERROR",
      time: new Date().toLocaleTimeString("en-US", { hour12: false }),
      msg: error instanceof Error ? error.message : String(error),
      trace: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : "",
    };
    fs.appendFileSync("bot-errors.log", `${JSON.stringify(errorPayload)}\n`);
    console.error(error);
    try { await message.reply("⚠️ Sorry, something went wrong. Please try again later."); } catch {}
  }
});

process.on("unhandledRejection", (reason) => { console.error("Unhandled rejection:", reason); });
process.on("uncaughtException", (error) => { console.error("Uncaught exception:", error); });

// --- Graceful Shutdown ---
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Cleaning up...`);
    logToFile(`[SHUTDOWN] Received ${signal}.`);
    saveBlacklist();
    try { terminalInterface?.close(); } catch {}
    try { discord.destroy(); } catch {}
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// --- Temp File Cleanup ---
function startTempCleanup(): void {
  const INTERVAL = 30 * 60 * 1000;
  setInterval(() => {
    const imageDir = path.join(process.cwd(), 'images_temps');
    const cutoff = Date.now() - 60 * 60 * 1000;
    try {
      if (fs.existsSync(imageDir)) {
        const files = fs.readdirSync(imageDir);
        for (const file of files) {
          const filePath = path.join(imageDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              fs.unlinkSync(filePath);
              debugLog("CLEANUP", `Removed old temp file: ${file}`);
            }
          } catch {}
        }
      }
    } catch {}
    try {
      const tmpFiles = fs.readdirSync(os.tmpdir());
      for (const file of tmpFiles) {
        if (!file.startsWith('yobnh_chrome_')) continue;
        const filePath = path.join(os.tmpdir(), file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(filePath, { recursive: true, force: true });
            debugLog("CLEANUP", `Removed old chrome profile: ${file}`);
          }
        } catch {}
      }
    } catch {}
  }, INTERVAL).unref();
  debugLog("CLEANUP", "Temp file cleanup scheduled every 30 minutes");
}

function startTempBlacklistCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [userId, expiry] of tempBlacklist) {
      if (now > expiry) {
        tempBlacklist.delete(userId);
        debugLog("TEMP BAN", `Ban expired for user ${userId}`);
      }
    }
  }, 60_000).unref();
  debugLog("TEMP BAN", "Temp blacklist cleanup scheduled every 60 seconds");
}

async function main() {
  const setupRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  console.log("----------------------------------------");
  console.log("before starting yobnh...");
  console.log("what mode do you want?");
  console.log("1) gpu usage (High history context, large intelligence models)");
  console.log("2) ram usage (Low memory footprint, small high-speed models)");
  console.log("----------------------------------------");
  
  const question = (query: string): Promise<string> => 
    new Promise((resolve) => setupRl.question(query, resolve));

  const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1];
  const envMode = process.env.RUNNING_MODE;
  let choice = (modeArg || envMode || "").trim();
  if (!choice) {
    choice = (await question("Select mode (1 or 2): ")).trim();
  }
  setupRl.close();

  if (choice === "2" || choice.toLowerCase() === "ram") {
    RUNNING_MODE = "ram";
    MAX_HISTORY = 6;
    RESPONSE_MODEL = process.env.RESPONSE_MODEL ?? (USE_MISTRAL ? "mistral-small-latest" : "gpt-4o-mini");
  } else {
    RUNNING_MODE = "gpu";
    MAX_HISTORY = 20;
    RESPONSE_MODEL = process.env.RESPONSE_MODEL ?? (USE_MISTRAL ? "mistral-large-latest" : "gpt-4o");
  }

  printStartupBanner();
  createConsoleInterface();
  setupGracefulShutdown();
  startHardwarePerformanceWatchdog();
  startTempCleanup();
  startTempBlacklistCleanup();
  loadBlacklist();

  if (!DISCORD_TOKEN) {
    console.error("Critical Error: DISCORD_TOKEN is missing from your environment setup.");
    process.exit(1);
  }

  discord.login(DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error);
    process.exit(1);
  });
}

async function runWithRetry(): Promise<void> {
  const MAX_RETRIES = 10;
  const RETRY_DELAY = 5000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await main();
      break;
    } catch (err) {
      console.error(`\n[FATAL] Bot crashed (attempt ${attempt}/${MAX_RETRIES}). Restarting in ${RETRY_DELAY / 1000}s...`);
      console.error(err);
      logToFile(`[FATAL] Bot crashed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
      if (attempt >= MAX_RETRIES) {
        console.error("[FATAL] Max retries reached. Giving up.");
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

runWithRetry();

// --- Interfaces ---
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

interface BrowserPageResult {
  title: string;
  url: string;
  content: string;
}

interface SearchResult {
  title: string;
  snippet: string;
}

interface DebugHttpResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}