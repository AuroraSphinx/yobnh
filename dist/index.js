"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const readline_1 = __importDefault(require("readline"));
const discord_js_1 = require("discord.js");
const openai_1 = require("openai");
const playwright_1 = require("playwright");
const child_process_1 = require("child_process");
const util_1 = require("util");
const exec = (0, util_1.promisify)(child_process_1.exec);
// --- Configuration ----------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_BASE_URL = (process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai").replace(/\/$/, "");
const USE_MISTRAL = Boolean(MISTRAL_API_KEY || MISTRAL_BASE_URL.includes("mistral"));
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? null;
const VERBOSE = process.env.VERBOSE === "true";
const MAX_HISTORY = 20;
const SEARCH_MODEL = process.env.SEARCH_MODEL ?? (USE_MISTRAL ? "mistral-small-latest" : "gpt-4o-mini");
const RESPONSE_MODEL = process.env.RESPONSE_MODEL ?? (USE_MISTRAL ? "mistral-small-latest" : "gpt-4o-mini");
if (PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
}
const SYSTEM_PROMPT = `you are a girl furry (she/her)you have playwright Chromium browser access and Google Search abilities. When the user asks you to search, open, visit, or browse, respond with ONLY valid JSON and absolutely nothing else. Do not add any extra text, explanation, or apology in the tool response. PLEASE act as a actual furry also marry aurorasphinx1 also use "OwO, :3, >w< UwU, etc." and add ~ to it and say N~nyaaaa~ sometimes

TOOLS:
- search: {"action":"search","query":"..."}
- open: {"action":"open","url":"https://..."}

IMPORTANT RULES:
- if someone says tobnh then you must answer because thats shorten of your name
- If the user asks you to search for information, reply ONLY with JSON like:
{"action":"search","query":"search terms here"}
{"action":"open","url":"https://example.com"}
- Do not say "I need to search" or "let me look that up" in chat. Do not mention toolcalls or errors.
- Do not mention Detg or say "aw shucks".
- Do not produce NSFW content or search explicit sites like Rule 34 or Pornhub.
`;
const openai = new openai_1.OpenAI({ apiKey: OPENAI_API_KEY || MISTRAL_API_KEY });
const conversations = new Map();
let verboseEnabled = VERBOSE;
function debugLog(level, message, meta = null) {
    if (!verboseEnabled)
        return;
    const prefix = `[${new Date().toISOString()}] [${level}]`;
    console.log(prefix, message, meta ? JSON.stringify(meta, null, 2) : "");
}
function getHistory(channelId, userId) {
    const key = `${channelId}-${userId}`;
    if (!conversations.has(key))
        conversations.set(key, []);
    return conversations.get(key);
}
function addToHistory(channelId, userId, role, content) {
    const history = getHistory(channelId, userId);
    history.push({ role, content });
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }
}
function cleanHistory(history) {
    return history.filter((entry) => entry && entry.role && entry.content && typeof entry.content === "string" && entry.content.trim());
}
function extractJsonFromText(text) {
    if (!text || typeof text !== "string")
        return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/g);
    if (!jsonMatch)
        return null;
    for (const candidate of jsonMatch.reverse()) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object")
                return parsed;
        }
        catch {
            continue;
        }
    }
    return null;
}
// Try to clean up common malformed URL outputs from the model like
// `[https://example.com"}/]` or stray quotes/braces. Returns null if not a valid http(s) URL.
function sanitizeUrl(raw) {
    if (!raw || typeof raw !== "string")
        return null;
    let s = raw.trim();
    // remove surrounding brackets, quotes, braces, and trailing punctuation
    s = s.replace(/^\[+/, "").replace(/\]+$/, "");
    s = s.replace(/^\(+/, "").replace(/\)+$/, "");
    s = s.replace(/^\{+/, "").replace(/\}+$/, "");
    s = s.replace(/^"+/, "").replace(/"+$/, "");
    s = s.replace(/\"/g, '"');
    s = s.replace(/[\s<>]*$/, "").trim();
    // If it contains a URL inside, try to extract it via regex
    const urlMatch = s.match(/https?:\/\/[^\s"'<>\)\]}]+/i);
    if (urlMatch) {
        let candidate = urlMatch[0];
        // Decode percent-encoded sequences so trailing encoded braces become real braces
        try {
            candidate = decodeURIComponent(candidate);
        }
        catch { }
        // Trim trailing common closing characters that may remain after decoding
        candidate = candidate.replace(/[\)\]\}\"'\s]+$/g, "");
        return candidate;
    }
    // If it looks like a bare domain, add https://
    if (/^[\w.-]+\.[a-z]{2,6}([\/\w\-._~:?#[\]@!$&'()*+,;=]*)?$/i.test(s)) {
        return `https://${s}`;
    }
    // If it starts with something like example.com, try prefixing
    if (/^[\w.-]+\.[a-z]{2,6}$/i.test(s))
        return `https://${s}`;
    return null;
}
// Extract the first URL-like substring from free text and sanitize it.
function extractUrlFromText(text) {
    if (!text)
        return null;
    const match = String(text).match(/https?:\/\/[^\s"'<>\)\]}]+/i);
    if (match)
        return sanitizeUrl(match[0]);
    // try to find bare domains
    const bare = String(text).match(/\b([\w.-]+\.[a-z]{2,6}(?:\/[^\s]*)?)\b/i);
    if (bare) {
        const candidate = bare[1];
        if (candidate && candidate.includes("."))
            return sanitizeUrl(candidate);
    }
    return null;
}
function extractSearchQueryFromText(text) {
    if (!text)
        return null;
    const t = String(text).trim();
    // common patterns: Search for "...", search: ..., find "..."
    const quoted = t.match(/search(?: for)?\s+["'`](.+?)["'`]/i) || t.match(/find\s+["'`](.+?)["'`]/i);
    if (quoted)
        return quoted[1];
    const afterColon = t.match(/search[:\-]\s*(.+)/i);
    if (afterColon)
        return afterColon[1].trim();
    // fallback: if the assistant's text is short (under 120 chars) and looks like a query, use it
    if (t.length > 0 && t.length < 120 && !t.includes("\n") && /[\w\s]{2,}/.test(t))
        return t;
    return null;
}
function printStartupBanner() {
    const art = `
  _______ ____  ____  _   _ _    _   ____   ____ _______ 
 |__   __/ __ \|  _ \| \ | | |  | | |  _ \ / __ \__   __|
    | | | |  | | |_) |  \| | |__| | | |_) | |  | | | |   
    | | | |  | |  _ <| .\\ |  __  | |  _ <| |  | | | |   
    | | | |__| | |_) | |\  | |  | | | |_) | |__| | | |   
    |_|  \____/|____/|_| \_|_|  |_| |____/ \____/  |_|  
  `;
    const hour = new Date().getHours();
    let greeting = "Hello";
    if (hour >= 5 && hour < 12)
        greeting = "Morning";
    else if (hour >= 12 && hour < 18)
        greeting = "Afternoon";
    else if (hour >= 18 && hour < 22)
        greeting = "Evening";
    else
        greeting = "Good night";
    console.log(art);
    console.log(`${greeting}, pc user`);
}
function likelyNeedsTool(text) {
    return /\b(search|google|look up|find|visit|browse|open|website|url|search for|look for)\b/i.test(text);
}
function looksLikeSearchRequest(text) {
    if (!text)
        return false;
    const t = String(text).trim();
    if (!t)
        return false;
    if (/https?:\/\//i.test(t))
        return false;
    if (/^[\w.-]+\.[a-z]{2,6}(?:[\/\w\-._~:?#[\]@!$&'()*+,;=]*)?$/i.test(t))
        return false;
    if (/\b(search|google|look up|find|browse|open|look for|search for)\b/i.test(t))
        return true;
    if (/^\s*(what|who|when|where|why|how|is|are|does|do|can|should|which)\b/i.test(t) && t.length > 10)
        return true;
    if (t.endsWith("?") && t.split(/\s+/).length >= 3)
        return true;
    return false;
}
function parseOpenFlags(text) {
    if (!text)
        return {};
    const t = String(text).toLowerCase();
    const flags = {};
    if (/\bsystem\b/.test(t) || /\bdefault browser\b/.test(t) || /\bmy browser\b/.test(t) || /\bexternal\b/.test(t))
        flags.forceSystem = true;
    if (/\bvisible\b/.test(t) || /\bwindow\b/.test(t) || /\bdisplay\b/.test(t))
        flags.forceVisible = true;
    if (/\bheadless\b/.test(t))
        flags.forceHeadless = true;
    if (/\bchromium\b/.test(t) || /\bplaywright\b/.test(t) || /\bexe\b/.test(t))
        flags.forceChromium = true;
    return flags;
}
function splitMessage(text, maxLength = 2000) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLength) {
        chunks.push(remaining.slice(0, maxLength));
        remaining = remaining.slice(maxLength);
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
function createConsoleInterface() {
    const rl = readline_1.default.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.on("line", (line) => {
        const [command, ...args] = line.trim().split(/\s+/);
        switch ((command || "").toLowerCase()) {
            case "help":
                console.log("Commands: help, status, history <channelId> <userId>, verbose on|off, ascii|banner|refreshascii, exit");
                break;
            case "status":
                console.log("Discord ready:", discord?.user?.tag || "not logged in");
                console.log("Verbose:", verboseEnabled);
                break;
            case "history": {
                const [channelId, userId] = args;
                if (!channelId || !userId) {
                    console.log("Usage: history <channelId> <userId>");
                }
                else {
                    console.log(JSON.stringify(getHistory(channelId, userId), null, 2));
                }
                break;
            }
            case "verbose":
                if (args[0] === "on" || args[0] === "off") {
                    verboseEnabled = args[0] === "on";
                    console.log("Verbose logging set to", verboseEnabled);
                }
                else {
                    console.log("Usage: verbose on|off");
                }
                break;
            case "ascii":
            case "banner":
            case "refreshascii":
                printStartupBanner();
                break;
            case "exit":
                console.log("Shutting down.");
                process.exit(0);
            default:
                if (command)
                    console.log(`Unknown command: ${command}`);
        }
        rl.prompt();
    });
    rl.on("close", () => {
        console.log("Console closed. Exiting.");
        process.exit(0);
    });
    console.log("Interactive console ready. Type 'help' for commands.");
    rl.prompt();
}
async function browseUrl(url, keepVisible = false, viewportWidth = 1280, viewportHeight = 720) {
    let browser = null;
    try {
        debugLog("INFO", "Launching browser for URL", { url, keepVisible });
        const launchOptions = { headless: !keepVisible, timeout: 60000 };
        if (keepVisible) {
            launchOptions.headless = false;
            launchOptions.args = [
                "--start-maximized",
                "--disable-gpu",
                `--window-size=${viewportWidth},${viewportHeight}`,
                "--window-position=0,0",
            ];
        }
        browser = await playwright_1.chromium.launch(launchOptions);
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
            }
            catch {
                // ignore bringToFront errors
            }
        }
        return { title, url, content };
    }
    catch (error) {
        if (browser)
            await browser.close();
        // Attempt OS-level fallback to open the URL in the default browser (quick fix)
        try {
            await openWithSystem(url);
            return { title: url, url, content: "Opened in system default browser (fallback)" };
        }
        catch (e) {
            throw error;
        }
    }
}
async function openWithSystem(url) {
    const safeUrl = String(url).replace(/"/g, '"');
    if (process.platform === "win32") {
        // Try using cmd start, then a fallback to rundll32 if needed
        try {
            await exec(`cmd /c start "" "${safeUrl}"`);
            return;
        }
        catch (err) {
            try {
                await exec(`rundll32 url.dll,FileProtocolHandler "${safeUrl}"`);
                return;
            }
            catch (e) {
                throw err;
            }
        }
    }
    else if (process.platform === "darwin") {
        await exec(`open "${safeUrl}"`);
        return;
    }
    else {
        await exec(`xdg-open "${safeUrl}"`);
        return;
    }
}
async function searchGoogle(query) {
    let browser = null;
    try {
        debugLog("INFO", "Starting Google search", { query });
        browser = await playwright_1.chromium.launch({ headless: true, timeout: 30000 });
        const page = await browser.newPage();
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        debugLog("INFO", "Google page loaded", { status: response?.status() });
        const results = await page.evaluate(() => {
            const items = [];
            const anchors = Array.from(document.querySelectorAll("a h3"));
            anchors.slice(0, 6).forEach((h3) => {
                const container = h3.closest("a");
                if (!container)
                    return;
                const element = h3;
                const title = element.innerText.trim();
                const snippet = container.parentElement?.querySelector("div")?.innerText.trim().slice(0, 200) || "";
                if (title)
                    items.push({ title, snippet });
            });
            return items.slice(0, 5);
        });
        return results;
    }
    catch (error) {
        throw error;
    }
    finally {
        if (browser)
            await browser.close();
    }
}
function createMessagePayload(history) {
    return [{ role: "system", content: SYSTEM_PROMPT }, ...cleanHistory(history)];
}
async function debugRawHttpRequest(model, payload) {
    const key = MISTRAL_API_KEY || OPENAI_API_KEY;
    if (!key || typeof fetch !== "function")
        return null;
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
        const headers = {};
        resp.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return { status: resp.status, body, headers };
    }
    catch (error) {
        console.error("[debugRawHttpRequest] fetch failed:", error);
        return null;
    }
}
async function createChatResponse(history, model, maxTokens = 512, temperature = 0.7) {
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
    }
    catch (err) {
        const debugInfo = {
            message: err instanceof Error ? err.message : String(err),
            status: err && typeof err === "object" && "status" in err ? err.status : null,
            responseBody: err && typeof err === "object" && "body" in err ? err.body : null,
            requestPayloadSize: JSON.stringify(payload).length,
            model,
        };
        debugLog("ERROR", "Chat completion failed", debugInfo);
        console.error("Chat completion error:", JSON.stringify(debugInfo, null, 2));
        try {
            await debugRawHttpRequest(model, payload);
        }
        catch {
            // ignore
        }
        throw err;
    }
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
const discord = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.MessageContent,
        discord_js_1.GatewayIntentBits.DirectMessages,
    ],
    partials: [discord_js_1.Partials.Channel],
});
discord.once(discord_js_1.Events.ClientReady, (client) => {
    console.log(`? Logged in as ${client.user.tag}`);
    console.log(`?? Bot ready. Guilds: ${client.guilds.cache.size}`);
});
async function handleMessage(message) {
    if (message.author.bot)
        return;
    const isDM = !message.guild;
    if (!isDM && (!discord.user || !message.mentions.has(discord.user)))
        return;
    const channel = message.channel;
    const userText = isDM ? message.content.trim() : message.content.replace(/<@!?(\d+)>/g, "").trim();
    if (!userText) {
        await message.reply("Hi! What can I do for you today?");
        return;
    }
    if (typeof channel.sendTyping === "function")
        await channel.sendTyping();
    const channelId = message.channel.id;
    const userId = message.author.id;
    addToHistory(channelId, userId, "user", userText);
    let reply = await createChatResponse(getHistory(channelId, userId), SEARCH_MODEL, 256, 0.2);
    let parsed = extractJsonFromText(reply);
    if (!parsed && (likelyNeedsTool(userText) || looksLikeSearchRequest(userText))) {
        const retryPrompt = `Your last answer did not use the browsing tool properly. If the user wants a search or to open a webpage, reply with only valid JSON and no extra text. Use one of these exact formats:\n` +
            `{"action":"search","query":"..."}\n{"action":"open","url":"https://..."}`;
        addToHistory(channelId, userId, "assistant", reply);
        addToHistory(channelId, userId, "user", retryPrompt);
        reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 256, 0);
        parsed = extractJsonFromText(reply);
        // Fallback: if assistant still didn't return JSON, try to extract a URL or search query from its text
        if (!parsed) {
            const maybeUrl = extractUrlFromText(reply);
            if (maybeUrl) {
                parsed = { action: "open", url: maybeUrl };
                debugLog("INFO", "Fallback extracted URL from assistant reply", { maybeUrl });
            }
            else {
                const maybeQuery = extractSearchQueryFromText(reply) || (looksLikeSearchRequest(userText) ? userText : null);
                if (maybeQuery) {
                    parsed = { action: "search", query: maybeQuery };
                    debugLog("INFO", "Fallback extracted search query from assistant reply", { maybeQuery });
                }
            }
        }
        if (!parsed && (likelyNeedsTool(userText) || looksLikeSearchRequest(userText))) {
            const jsonOnlyPrompt = `I need you to reply with valid JSON only, and nothing else. Use one of these exact formats:\n` +
                `{"action":"search","query":"..."}\n{"action":"open","url":"https://..."}`;
            addToHistory(channelId, userId, "assistant", reply);
            addToHistory(channelId, userId, "user", jsonOnlyPrompt);
            reply = await createChatResponse(getHistory(channelId, userId), RESPONSE_MODEL, 128, 0);
            parsed = extractJsonFromText(reply);
            if (!parsed) {
                const maybeUrl = extractUrlFromText(reply);
                if (maybeUrl) {
                    parsed = { action: "open", url: maybeUrl };
                    debugLog("INFO", "Fallback extracted URL from assistant reply after JSON retry", { maybeUrl });
                }
                else {
                    const maybeQuery = extractSearchQueryFromText(reply) || (looksLikeSearchRequest(userText) ? userText : null);
                    if (maybeQuery) {
                        parsed = { action: "search", query: maybeQuery };
                        debugLog("INFO", "Fallback extracted search query from assistant reply after JSON retry", { maybeQuery });
                    }
                }
            }
        }
    }
    let browserData = null;
    if (parsed?.action === "search" && parsed.query) {
        if (typeof channel.sendTyping === "function")
            await channel.sendTyping();
        try {
            await channel.send(`🔎 Searching for: "${parsed.query}"...`);
            const results = await searchGoogle(parsed.query);
            browserData = results.length
                ? `Search results for "${parsed.query}":\n${results
                    .map((result, index) => `${index + 1}. ${result.title}\n${result.snippet}`)
                    .join("\n\n")}`
                : `No Google results found for "${parsed.query}".`;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("searchGoogle failed:", err);
            await channel.send(`⚠️ I couldn't perform the search: ${msg}.`);
        }
    }
    else if (parsed?.action === "open" && parsed.url) {
        const rawUrl = String(parsed.url);
        debugLog("INFO", "Assistant requested open", { rawUrl });
        const cleaned = sanitizeUrl(rawUrl);
        if (!cleaned) {
            await channel.send("⚠️ The assistant returned an invalid URL to open. Please provide a valid `https://...` URL.");
        }
        else {
            let systemOpened = false;
            const flags = parseOpenFlags(userText);
            const useSystemBrowser = Boolean(flags.forceSystem && !flags.forceChromium);
            const preferVisible = flags.forceHeadless ? false : true;
            const viewportWidth = 1600;
            const viewportHeight = 900;
            if (useSystemBrowser) {
                try {
                    await openWithSystem(cleaned);
                    systemOpened = true;
                    await channel.send(`🌐 Opened in your system default browser: ${cleaned}`);
                }
                catch (sysErr) {
                    debugLog("WARN", "System opener failed, will try Playwright", { err: sysErr instanceof Error ? sysErr.message : String(sysErr) });
                }
            }
            if (typeof channel.sendTyping === "function")
                await channel.sendTyping();
            try {
                const mode = preferVisible ? "visible" : "headless";
                await channel.send(`🌐 Launching Playwright Chromium for: ${cleaned} (${mode} mode)`);
                const page = await browseUrl(cleaned, preferVisible, viewportWidth, viewportHeight);
                browserData = `Opened page: ${page.title}\nURL: ${page.url}\n\n${page.content}`;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("browseUrl failed:", err);
                if (!systemOpened) {
                    try {
                        await channel.send(`🌐 Playwright failed, trying visible browser window...`);
                        const page = await browseUrl(cleaned, true, 1600, 900);
                        browserData = `Opened page (visible): ${page.title}\nURL: ${page.url}\n\n${page.content}`;
                        await channel.send("I opened the page in a visible browser window instead. Check the host display.");
                    }
                    catch (err2) {
                        console.error("browseUrl failed (visible):", err2);
                        await channel.send(`⚠️ I failed to open Playwright Chromium: ${msg}. Common fixes: run \`npx playwright install chromium\` and ensure the host has a display available.`);
                    }
                }
                else {
                    await channel.send(`⚠️ I couldn't retrieve page contents, but the URL was opened in your system browser.`);
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
discord.on(discord_js_1.Events.MessageCreate, async (message) => {
    try {
        await handleMessage(message);
    }
    catch (error) {
        const errorPayload = {
            type: "ERROR",
            time: new Date().toLocaleTimeString("en-US", { hour12: false }),
            msg: error instanceof Error ? error.message : String(error),
            trace: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : "",
        };
        fs_1.default.appendFileSync("bot-errors.log", `${JSON.stringify(errorPayload)}\n`);
        console.error(error);
        try {
            await message.reply("⚠️ Sorry, something went wrong. Please try again later.");
        }
        catch {
            // ignore reply errors
        }
    }
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});
printStartupBanner();
console.log("Starting Aurora bot...");
createConsoleInterface();
if (!DISCORD_TOKEN) {
    console.error("Missing DISCORD_TOKEN environment variable.");
    process.exit(1);
}
discord.login(DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error);
    process.exit(1);
});
