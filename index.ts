// Silence the annoying DEP0190 child_process warning globally
process.removeAllListeners('warning'); 
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('DEP0190')) {
    return; // Ignore it completely
  }
  console.warn(warning.stack); // Let other important warnings through
});

// --- IMPORTS ---
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import readline from "readline";
import { Client, GatewayIntentBits, Events, Message, REST, Routes, SlashCommandBuilder, AttachmentBuilder, PermissionsBitField, EmbedBuilder } from "discord.js";
import { OpenAI } from "openai";
import { chromium, Browser } from "playwright";
import { exec as execCb, spawn, execFile } from "child_process";
import { promisify } from "util";
import pidusage from "pidusage"; // Import pidusage to track system performance loads

const exec = promisify(execCb);
const username = os.userInfo().username;

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

// Variable states configured dynamically on startup
let RUNNING_MODE: "gpu" | "ram" = "gpu";
let MAX_HISTORY = 20;
let RESPONSE_MODEL = "";
let isThrottled = false; // Lock flag to prevent the bot from running tasks during high resource usage

if (PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
}

const SYSTEM_PROMPT = `you are a girl and idk dont use emojis also you have playwright so that means you can open browser and headless too act as like a user human also dont say you are ai assistant or smth pls

RULES FOR TALKING:
- If you are just chatting, answering a question directly, or hanging out, respond with REGULAR CONVERSATIONAL TEXT. Do not use JSON for normal talking.

RULES FOR ACTIONS (If you explicitly need to use a tool):
- search: {"action":"search","query":"..."}
- open: {"action":"open","url":"https://..."}
- launch app: {"action":"launch","app":"notepad","type":"optional text to type"}
- move mouse: {"action":"mouse_move","x":800,"y":450}
- click mouse: {"action":"mouse_click","x":800,"y":450,"button":"left"}
- kick user: {"action":"kick","user":"username_or_id","reason":"optional reason"}
- timeout user: {"action":"timeout","user":"username_or_id","duration":600,"reason":"optional reason"}
- untimeout user: {"action":"untimeout","user":"username_or_id","reason":"optional reason"}
- ban user: {"action":"ban","user":"username_or_id","reason":"optional reason"}
- unban user: {"action":"unban","user":"username_or_id","reason":"optional reason"}
- If you need to perform actions, you can send a SINGLE action or an ARRAY of actions to execute them sequentially.
- Your response must be ONLY valid JSON with NO conversational text around it ONLY when using actions.

Example format for sequential actions:
[
  {"action":"mouse_move","x":160,"y":500},
  {"action":"mouse_click","x":160,"y":500,"button":"left"}
]
IMPORTANT RULES:
- If you gonna use the mouse thing DONT say random chinese words
- if someone says yobnh then you must answer because thats shorten of your name
- If the user asks you to search for information, reply ONLY with JSON.
- Do not say "I need to search" or "let me look that up" in chat. Do not mention toolcalls or errors.
- NEVER open google.com as a URL. For searches, ALWAYS use the search action: {"action":"search","query":"..."}. The open action is for non-Google websites only.
- Do not mention Detg or say "aw shucks".
- Do not produce NSFW content or search explicit sites like Rule 34 or Pornhub.
`;

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
  return blacklistedUsers.has(userId);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY || MISTRAL_API_KEY });
const conversations = new Map<string, ChatMessage[]>();
let verboseEnabled = VERBOSE;

function debugLog(level: string, message: string, meta: Record<string, unknown> | null = null): void {
  if (!verboseEnabled) return;
  const prefix = `[${new Date().toISOString()}] [${level}]`;
  console.log(prefix, message, meta ? JSON.stringify(meta, null, 2) : "");
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
  terminalInterface = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  terminalInterface.on("line", (line) => {
    const [command, ...args] = line.trim().split(/\s+/);
    switch ((command || "").toLowerCase()) {
      case "help":
        console.log("Commands: help, status, history <channelId> <userId>, verbose on|off, blacklist add|remove|list <userId>, ascii, exit");
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

  if (process.platform === "win32") {
    const tempVbsFile = path.join(os.tmpdir(), "yobnh_perf_warn.vbs");
    const sanitizedBody = bodyText.replace(/"/g, "'").replace(/\n/g, '" & vbCrLf & "');
    const vbsContent = `MsgBox "${sanitizedBody}", 48, "${titleMessage}"`;
    
    fs.writeFileSync(tempVbsFile, vbsContent);
    const child = spawn("wscript.exe", [tempVbsFile], { detached: true, stdio: "ignore" });
    child.unref();
    setTimeout(() => { try { if (fs.existsSync(tempVbsFile)) fs.unlinkSync(tempVbsFile); } catch {} }, 5000);
  } else if (process.platform === "darwin") {
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

async function browseUrl(url: string, keepVisible = false, viewportWidth = 1280, viewportHeight = 720): Promise<BrowserPageResult> {
  let browser: Browser | null = null;
  try {
    debugLog("INFO", "Launching browser for URL", { url, keepVisible });
    const launchOptions: any = { headless: !keepVisible, timeout: 60000 };
    if (keepVisible) {
      launchOptions.headless = false;
      launchOptions.args = [
        "--start-maximized",
        "--disable-gpu",
        `--window-size=${viewportWidth},${viewportHeight}`,
        "--window-position=0,0",
      ];
    }
    
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: keepVisible ? { width: viewportWidth, height: viewportHeight } : null });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    debugLog("INFO", "Browser navigated", { status: response?.status(), ok: response?.ok() });

    const title = await page.title();
    const content = await page.evaluate(() => {
      const blocked = document.querySelectorAll("script, style, nav, footer, header, aside, noscript");
      blocked.forEach((node) => node.remove());
      return document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 3000);
    });

    if (!keepVisible && browser) {
      await browser.close();
    }

    if (keepVisible) {
      try {
        await page.bringToFront();
        await page.evaluate(() => window.focus());
        await page.waitForTimeout(2000);
      } catch {}
    }

    return { title, url, content };
  } catch (error) {
    if (browser) await browser.close();
    try {
      await openWithSystem(url);
      return { title: url, url, content: "Opened in system default browser (fallback)" };
    } catch (e) {
      throw error;
    }
  }
}

async function openWithSystem(url: string): Promise<void> {
  const safeUrl = String(url).replace(/"/g, '"');
  if (process.platform === "win32") {
    try {
      await execFile("cmd.exe", ["/c", "start", "", safeUrl]);
      return;
    } catch (err) {
      try {
        await execFile("rundll32.exe", ["url.dll,FileProtocolHandler", safeUrl]);
        return;
      } catch (e) {
        throw err;
      }
    }
  } else if (process.platform === "darwin") {
    await exec(`open "${safeUrl}"`);
    return;
  } else {
    await exec(`xdg-open "${safeUrl}"`);
    return;
  }
}

async function searchGoogle(query: string): Promise<SearchResult[]> {
  let browser: Browser | null = null;
  try {
    debugLog("INFO", "Starting Google search", { query });
    browser = await chromium.launch({
      headless: false,
      timeout: 30000,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    debugLog("INFO", "Google page loaded", { status: response?.status() });

    const isCaptcha = await page.evaluate(() => {
      return document.body.innerText.includes("unusual traffic") ||
             document.body.innerText.includes("not a robot") ||
             document.body.innerText.includes("captcha") ||
             !!document.querySelector("form[action*='sorry']") ||
             !!document.querySelector("#recaptcha");
    });

    if (isCaptcha) {
      debugLog("WARN", "Google bot verification detected, waiting for manual solve");
      await page.waitForNavigation({ timeout: 120000 }).catch(() => {});
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = await page.evaluate(() => {
      const items: Array<{ title: string; snippet: string }> = [];
      const anchors = Array.from(document.querySelectorAll("a h3"));
      anchors.slice(0, 6).forEach((h3) => {
        const container = h3.closest("a");
        if (!container) return;
        const element = h3 as HTMLElement;
        const title = element.innerText.trim();
        const snippet = container.parentElement?.querySelector("div")?.innerText.trim().slice(0, 200) || "";
        if (title) items.push({ title, snippet });
      });
      return items.slice(0, 5);
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    return results;
  } catch (error) {
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function createMessagePayload(history: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...cleanHistory(history)];
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

function parseOpenFlags(text: string | null | undefined): { forceSystem?: boolean; forceVisible?: boolean; forceHeadless?: boolean; forceChromium?: boolean } {
  if (!text) return {};
  const t = String(text).toLowerCase();
  const flags: { forceSystem?: boolean; forceVisible?: boolean; forceHeadless?: boolean; forceChromium?: boolean } = {};
  if (/\bsystem\b/.test(t) || /\bdefault browser\b/.test(t) || /\bmy browser\b/.test(t) || /\bexternal\b/.test(t)) flags.forceSystem = true;
  if (/\bvisible\b/.test(t) || /\bwindow\b/.test(t) || /\bdisplay\b/.test(t)) flags.forceVisible = true;
  if (/\bheadless\b/.test(t)) flags.forceHeadless = true;
  if (/\bchromium\b/.test(t) || /\bplaywright\b/.test(t) || /\bexe\b/.test(t)) flags.forceChromium = true;
  return flags;
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans, // Added for unban support functionality clarity
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

async function moveMouse(x: number, y: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
    const child = spawn("powershell.exe", ["-Command", ps], { stdio: "pipe" });
    child.on("close", () => resolve(`Moved mouse to (${x}, ${y})`));
    child.on("error", reject);
  });
}

async function clickMouse(x: number, y: number, button: "left" | "right" = "left"): Promise<string> {
  return new Promise((resolve, reject) => {
    const flags = button === "right" ? "0x0008, 0, 0, 0, 0); $t::mouse_event(0x0010" : "0x0002, 0, 0, 0, 0); $t::mouse_event(0x0004";
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
      `$sig = '[DllImport(\"user32.dll\")] public static extern void mouse_event(int f, int dx, int dy, int b, int e);'`,
      "$t = Add-Type -MemberDefinition $sig -Name Mouse -Namespace Win32 -PassThru",
      `$t::mouse_event(${flags}, 0, 0)`
    ].join("; ");
    const child = spawn("powershell.exe", ["-Command", ps], { stdio: "pipe" });
    child.on("close", () => resolve(`Clicked ${button} at (${x}, ${y})`));
    child.on("error", reject);
  });
}

async function launchApp(appName: string, typeText?: string): Promise<string> {
  const appMap: Record<string, string> = {
    notepad: "notepad.exe", calculator: "calc.exe", calc: "calc.exe",
    paint: "mspaint.exe", explorer: "explorer.exe", cmd: "cmd.exe",
    powershell: "powershell.exe", spotify: "spotify.exe", chrome: "chrome.exe",
    firefox: "firefox.exe", vlc: "vlc.exe", wordpad: "wordpad.exe",
    excel: "excel.exe", word: "winword.exe",
    "visual studio": "devenv.exe", vscode: "code.exe", "vs code": "code.exe",
    "visual studio code": "code.exe", rider: "rider64.exe",
    "unity hub": "Unity Hub.exe", unity: "Unity.exe",
    dotnet: "dotnet.exe", "dotnet studio": "dotnet.exe",
  };

  const isFullPath = appName.includes("\\") || appName.includes("/") || /^[a-zA-Z]:/.test(appName);
  const alreadyExe = appName.toLowerCase().endsWith(".exe");
  const exe = isFullPath ? appName : (appMap[appName.toLowerCase()] || (alreadyExe ? appName : `${appName}.exe`));

  return new Promise((resolve, reject) => {
    execFile("cmd.exe", ["/c", "start", "", exe], (err) => {
      if (err) {
        reject(new Error(`Failed to launch ${appName}: ${err.message}`));
      }
    });
    setTimeout(async () => {
      if (typeText) {
        const escaped = typeText.replace(/'/g, "''").replace(/`/g, "``");
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
        const psChild = spawn("powershell.exe", ["-Command", ps], { detached: true, stdio: "ignore", shell: false });
        psChild.unref();
        resolve(`Opened ${appName} and typed: "${typeText}"`);
      } else {
        resolve(`Opened ${appName}!`);
      }
    }, 1500);
  });
}

const SCREEN_W = 1600;
const SCREEN_H = 900;
const GRID_COLS = 16;
const GRID_ROWS = 9;
const CELL_W = SCREEN_W / GRID_COLS;
const CELL_H = SCREEN_H / GRID_ROWS;

async function captureGridScreenshot(outputPath: string): Promise<void> {
  const screenshotPath = outputPath.replace(".png", "_raw.png");
  const escapedPath = screenshotPath.replace(/\\/g, "\\\\");

  await new Promise<void>((resolve, reject) => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $s = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($s.Bounds.Width, $s.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::Empty, $s.Bounds.Size); $bmp.Save('${escapedPath}'); $g.Dispose(); $bmp.Dispose()`;
    const child = spawn("powershell.exe", ["-Command", ps], { stdio: "pipe" });
    child.on("close", (code: number) => code === 0 ? resolve() : reject(new Error("Screenshot failed code " + code)));
    child.on("error", reject);
  });

  const { Jimp } = require("jimp");
  const img = await Jimp.read(screenshotPath);

  const GRID_COLOR = 0xff0000ff;
  const TEXT_COLOR = 0xffffffff;

  for (let col = 0; col <= GRID_COLS; col++) {
    const px = Math.round(col * CELL_W);
    for (let py = 0; py < SCREEN_H; py++) {
      if (px < SCREEN_W) img.setPixelColor(GRID_COLOR, px, py);
      if (px + 1 < SCREEN_W) img.setPixelColor(GRID_COLOR, px + 1, py);
    }
  }

  for (let row = 0; row <= GRID_ROWS; row++) {
    const py = Math.round(row * CELL_H);
    for (let px = 0; px < SCREEN_H; px++) {
      if (py < SCREEN_H) img.setPixelColor(GRID_COLOR, py, px);
      if (py + 1 < SCREEN_H) img.setPixelColor(GRID_COLOR, py + 1, px);
    }
  }

  const fontMaps: Record<string, number[][]> = {
    A: [[0,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0]],
    B: [[1,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,0,0]],
    C: [[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[0,1,1,1,0]],
    D: [[1,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,0,0]],
    E: [[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0]],
    F: [[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0]],
    G: [[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,1,1,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,1,0]],
    H: [[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0]],
    I: [[1,1,1,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[1,1,1,0,0]],
    J: [[0,0,1,1,0],[0,0,0,1,0],[0,0,0,1,0],[0,0,0,1,0],[0,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0]],
    K: [[1,0,0,1,0],[1,0,1,0,0],[1,1,0,0,0],[1,1,0,0,0],[1,0,1,0,0],[1,0,1,0,0],[1,0,0,1,0]],
    L: [[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0]],
    M: [[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1]],
    N: [[1,0,0,0,1],[1,1,0,0,1],[1,0,1,0,1],[1,0,1,0,1],[1,0,0,1,1],[1,0,0,0,1],[1,0,0,0,1]],
    O: [[0,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0]],
    P: [[1,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0]],
    "1": [[0,1,0,0,0],[1,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0],[1,1,1,0,0]],
    "2": [[0,1,1,0,0],[1,0,0,1,0],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,0,0,0,0],[1,1,1,1,0]],
    "3": [[1,1,1,0,0],[0,0,0,1,0],[0,0,0,1,0],[0,1,1,0,0],[0,0,0,1,0],[0,0,0,1,0],[1,1,1,0,0]],
    "4": [[1,0,0,1,0],[1,0,0,1,0],[1,0,0,1,0],[1,1,1,1,0],[0,0,0,1,0],[0,0,0,1,0],[0,0,0,1,0]],
    "5": [[1,1,1,1,0],[1,0,0,0,0],[1,1,1,0,0],[0,0,0,1,0],[0,0,0,1,0],[1,0,1,0,0],[0,1,1,0,0]],
    "6": [[0,1,1,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0]],
    "7": [[1,1,1,1,0],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0]],
    "8": [[0,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0]],
    "9": [[0,1,1,0,0],[1,0,0,1,0],[1,0,0,1,0],[0,1,1,1,0],[0,0,0,1,0],[1,0,0,1,0],[0,1,1,0,0]]
  };

  const drawPixelChar = (char: string, startX: number, startY: number) => {
    const matrix = fontMaps[char];
    if (!matrix) return;
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        if (matrix[r][c] === 1) {
          const targetX = startX + (c * 2);
          const targetY = startY + (r * 2);
          for (let sx = 0; sx < 2; sx++) {
            for (let sy = 0; sy < 2; sy++) {
              if (targetX + sx < SCREEN_W && targetY + sy < SCREEN_H) {
                img.setPixelColor(TEXT_COLOR, targetX + sx, targetY + sy);
              }
            }
          }
        }
      }
    }
  };

  const columns = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P"];

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const cellX = Math.round(col * CELL_W);
      const cellY = Math.round(row * CELL_H);
      const letter = columns[col];
      const numberStr = String(row + 1);
      drawPixelChar(letter, cellX + 10, cellY + 10);
      drawPixelChar(numberStr, cellX + 24, cellY + 10);
    }
  }

  await img.write(outputPath);
  try { fs.unlinkSync(screenshotPath); } catch {}
}

async function registerSlashCommands(clientId: string, token: string): Promise<void> {
  const guildCommands = [
    new SlashCommandBuilder().setName("grid").setDescription("Screenshot your screen with a grid overlay").toJSON(),
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
    new SlashCommandBuilder()
      .setName("update-channel")
      .setDescription("Set a channel to receive latest commit updates from the repo")
      .addChannelOption(option =>
        option.setName("channel").setDescription("The channel to post commit updates to").setRequired(true)
      )
      .setDMPermission(false)
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    console.log("Synchronizing slash command arrays...");
    await rest.put(Routes.applicationCommands(clientId), { body: guildCommands });
    console.log("✅ Slash commands registered globally (app commands): /grid, /send-dm, /health-check, /ask, /yobnh-member, /update-channel");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}

discord.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (isBlacklisted(interaction.user.id)) {
    interaction.reply({ content: "Sorry but you are blacklisted from AuroraSphinx.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "grid") {
    setImmediate(async () => {
      try {
        await interaction.deferReply();
      } catch (deferError: any) {
        if (deferError?.code !== 10062) {
          console.error("[DISCORD TIMEOUT] Real connection failure:", deferError);
          return;
        }
      }

      const outputPath = path.join(process.cwd(), "grid_screenshot.png");
      try {
        await captureGridScreenshot(outputPath);
        const attachment = new AttachmentBuilder(outputPath, { name: "grid.png" });
        await interaction.editReply({
          content: "Here is your screen with a grid overlay! Cells are labeled A1-P9. Tell me a coordinate to click!",
          files: [attachment],
        });
        setTimeout(() => { try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {} }, 5000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Grid screenshot collection or upload failed:", err);
        try { await interaction.editReply(`Screenshot failed: ${msg}`); } catch {}
      }
    });
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
          .setTitle("Bot Health Check")
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
        const askFn = (global as any).askAI;
        if (!askFn) {
          await interaction.editReply("AI system is not initialized yet.");
          return;
        }

        const reply = await askFn(prompt);
        const chunks = splitMessage(reply, 2000);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
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
        const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=10`;
        const resp = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "yobnh-bot",
          },
        });

        if (!resp.ok) {
          const body = await resp.text();
          const failEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("❌ Commit Fetch Failed")
            .setDescription(`GitHub API returned \`${resp.status}\`:\n\`\`\`${body.slice(0, 500)}\`\`\``)
            .setTimestamp();
          await interaction.editReply({ embeds: [failEmbed] });
          return;
        }

        const commits: any[] = await resp.json();

        if (!commits.length) {
          const failEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("❌ No Commits Found")
            .setDescription("The repository returned zero commits.")
            .setTimestamp();
          await interaction.editReply({ embeds: [failEmbed] });
          return;
        }

        const fields = commits.map((c: any) => ({
          name: `\`${c.sha.slice(0, 7)}\``,
          value: c.commit.message.split("\n")[0],
          inline: false,
        }));

        const successEmbed = new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle("✅ Latest Commits — Update Channel")
          .setDescription(`Fetched **${commits.length}** commit(s) from \`${GITHUB_REPO}\``)
          .addFields(fields)
          .setFooter({ text: `Repo: ${GITHUB_REPO}` })
          .setTimestamp();

        const target = discord.channels.cache.get(targetChannel.id);
        if (!target || !("send" in target)) {
          await interaction.editReply({ content: "❌ Could not access the specified channel." });
          return;
        }

        await (target as any).send({ embeds: [successEmbed] });
        await interaction.editReply({ content: `✅ Commit updates posted to <#${targetChannel.id}>` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const failEmbed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle("❌ Commit Fetch Failed")
          .setDescription(`\`\`\`${msg}\`\`\``)
          .setTimestamp();
        try { await interaction.editReply({ embeds: [failEmbed] }); } catch {}
      }
    });
  }
});

discord.once(Events.ClientReady, async (client) => {
  console.log(`? Logged in as ${client.user.tag}`);
  console.log(`?? Bot ready. Guilds: ${client.guilds.cache.size}`);
  try {
    await registerSlashCommands(client.user.id, DISCORD_TOKEN);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

async function executeSingleAction(parsed: any, channel: any, userId: string, channelId: string): Promise<void> {
  if (parsed?.action === "mouse_move" && parsed.x !== undefined && parsed.y !== undefined) {
    try {
      const result = await moveMouse(Number(parsed.x), Number(parsed.y));
      await channel.send(`鼠标移动: ${result}`);
      addToHistory(channelId, userId, "assistant", result);
    } catch (err) {
      await channel.send(`⚠️ Mouse move failed: ${err instanceof Error ? err.message : String(err)}`);
      addToHistory(channelId, userId, "assistant", `Error executing mouse_move: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (parsed?.action === "mouse_click" && parsed.x !== undefined && parsed.y !== undefined) {
    try {
      const btn = parsed.button === "right" ? "right" : "left";
      const result = await clickMouse(Number(parsed.x), Number(parsed.y), btn as "left" | "right");
      await channel.send(`鼠标点击: ${result}`);
      addToHistory(channelId, userId, "assistant", result);
    } catch (err) {
      await channel.send(`⚠️ Mouse click failed: ${err instanceof Error ? err.message : String(err)}`);
      addToHistory(channelId, userId, "assistant", `Error executing mouse_click: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (parsed?.action === "launch" && parsed.app) {
    try {
      const result = await launchApp(String(parsed.app), parsed.type ? String(parsed.type) : undefined);
      await channel.send(`🖥️ ${result}`);
      addToHistory(channelId, userId, "assistant", result);
    } catch (err) {
      await channel.send(`⚠️ Launch failed: ${err instanceof Error ? err.message : String(err)}`);
      addToHistory(channelId, userId, "assistant", `Error launching app: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  if (isBlacklisted(message.author.id)) {
    await message.reply("Sorry but you are blacklisted from AuroraSphinx.");
    return;
  }

  if (isThrottled) {
    await message.reply("⚠️ **Performance Safety Intercept:** The system load usage is currently too high right now! Cooling down... please wait a moment.");
    return;
  }

  const isDM = !message.guild;
  if (!isDM && (!discord.user || !message.mentions.has(discord.user))) return;

  if (isSpamming(message.author.id)) {
    return;
  }

  const channel = message.channel as any;
  const userText = isDM ? message.content.trim() : message.content.replace(/<@!?(\d+)>/g, "").trim();
  if (!userText) {
    await message.reply("Hi! What can I do for you today?");
    return;
  }

  if (typeof channel.sendTyping === "function") await channel.sendTyping();
  const channelId = message.channel.id;
  const userId = message.author.id;
  addToHistory(channelId, userId, "user", userText);

  let reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 256, 0.4);
  let parsed = extractJsonFromText(reply);

  if (parsed) {
    addToHistory(channelId, userId, "assistant", reply);

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        await executeSingleAction(item, channel, userId, channelId);
      }
      return;
    } else if (parsed.action === "mouse_move" || parsed.action === "mouse_click" || parsed.action === "launch" || parsed.action === "kick" || parsed.action === "timeout" || parsed.action === "untimeout" || parsed.action === "ban" || parsed.action === "unban") {
      await executeSingleAction(parsed, channel, userId, channelId);
      return;
    }
  }

  let browserData: string | null = null;

  if (parsed?.action === "search" && parsed.query) {
    if (typeof channel.sendTyping === "function") await channel.sendTyping();
    try {
      await channel.send(`🔎 Searching for: "${parsed.query}"...`);
      const results = await searchGoogle(parsed.query);
      browserData = results.length
        ? `Search results for "${parsed.query}":\n${results
            .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
            .join("\n\n")}`
        : `No Google results found for "${parsed.query}".`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
    }
  } else if (parsed?.action === "open" && parsed.url) {
    const rawUrl = String(parsed.url);
    const cleaned = sanitizeUrl(rawUrl);
    if (!cleaned) {
      await channel.send("⚠️ The assistant returned an invalid URL to open. Please provide a valid `https://...` URL.");
    } else if (/google\.com\/search/i.test(cleaned)) {
      let googleQuery = userText;
      try { googleQuery = new URL(cleaned).searchParams.get("q") || userText; } catch {}
      if (typeof channel.sendTyping === "function") await channel.sendTyping();
      try {
        await channel.send(`🔎 Searching for: "${googleQuery}"...`);
        const results = await searchGoogle(googleQuery);
        browserData = results.length
          ? `Search results for "${googleQuery}":\n${results
              .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
              .join("\n\n")}`
          : `No Google results found for "${googleQuery}".`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
      }
    } else if (/^(https?:\/\/)?(www\.)?google\.com\/?$/i.test(cleaned)) {
      if (typeof channel.sendTyping === "function") await channel.sendTyping();
      try {
        await channel.send(`🔎 Searching for: "${userText}"...`);
        const results = await searchGoogle(userText);
        browserData = results.length
          ? `Search results for "${userText}":\n${results
              .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
              .join("\n\n")}`
          : `No Google results found for "${userText}".`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
      }
    } else {
      let systemOpened = false;
      const flags = parseOpenFlags(userText);
      const useSystemBrowser = Boolean(flags.forceSystem && !flags.forceChromium);
      const preferVisible = !flags.forceHeadless;

      if (useSystemBrowser) {
        try {
          await openWithSystem(cleaned);
          systemOpened = true;
          await channel.send(`🌐 Opened in your system default browser: ${cleaned}`);
        } catch (sysErr) {}
      }

      if (typeof channel.sendTyping === "function") await channel.sendTyping();
      try {
        const mode = preferVisible ? "visible" : "headless";
        await channel.send(`🌐 Launching Playwright Chromium for: ${cleaned} (${mode} mode)`);
        const page = await browseUrl(cleaned, preferVisible, 1600, 900);
        browserData = `Opened page: ${page.title}\nURL: ${page.url}\n\n${page.content}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!systemOpened) {
          try {
            await channel.send(`🌐 Playwright failed, trying visible browser window...`);
            const page = await browseUrl(cleaned, true, 1600, 900);
            browserData = `Opened page (visible): ${page.title}\nURL: ${page.url}\n\n${page.content}`;
          } catch (err2) {
            await channel.send(`⚠️ I failed to open Playwright Chromium: ${msg}.`);
          }
        }
      }
    }
  }

  if (browserData) {
    addToHistory(channelId, userId, "assistant", reply);
    addToHistory(channelId, userId, "user", `Browser results:\n${browserData}\n\nPlease answer the original question using this information.`);
    reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 1024, 0.5);
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
    
  const choice = (await question("Select mode (1 or 2): ")).trim();
  setupRl.close();

  if (choice === "2") {
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
  startHardwarePerformanceWatchdog();
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

main();

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