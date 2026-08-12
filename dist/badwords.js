"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HATE_SLURS = void 0;
exports.detectBadWords = detectBadWords;
exports.HATE_SLURS = [
    "nigger",
    "nigga",
    "n1gger",
    "niggers",
    "niggas",
    "kike",
    "kikes",
    "faggot",
    "faggots",
    "fag",
    "fags",
    "retard",
    "retards",
    "retarded",
    "tranny",
    "trannies",
    "transexual",
    "transvestite",
    "dyke",
    "dykes",
    "chink",
    "chinks",
    "spic",
    "spics",
    "wetback",
    "wetbacks",
    "beaner",
    "beaners",
    "gook",
    "gooks",
    "jap",
    "cunt",
    "cunts",
    "whore",
    "whores",
    "bitch",
    "bitches",
    "bitchy",
    "fuck",
    "fucks",
    "fucker",
    "fuckers",
    "fucked",
    "fucking",
    "motherfucker",
    "motherfuckers",
    "motherfucking",
    "shit",
    "shits",
    "shitter",
    "shitters",
    "shitty",
    "bullshit",
    "horseshit",
    "asshole",
    "assholes",
    "bastard",
    "bastards",
    "slut",
    "sluts",
    "pussy",
    "dick",
    "dicks",
    "cock",
    "cocks",
    "porn",
    "hentai",
    "rape",
    "raped",
    "rapist",
    "rapists",
    "kill",
    "killed",
    "killer",
    "suicide",
    "kill yourself",
    "kys",
    "nazi",
    "nazis",
    "hitler",
    "kkk",
    "racist",
    "racists",
    "nword",
    "n-word",
];
function cleanText(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function leetToText(text) {
    const map = {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "8": "b",
        "@": "a",
        "$": "s",
        "!": "i",
    };
    let out = "";
    for (const ch of text) {
        out += map[ch] ?? ch;
    }
    return out;
}
function wordBoundaryRegex(word) {
    return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
}
function detectBadWords(text) {
    if (!text)
        return [];
    const cleaned = cleanText(text);
    const deleet = leetToText(cleaned);
    const matches = [];
    for (const slur of exports.HATE_SLURS) {
        const lower = slur.toLowerCase();
        const rawHit = wordBoundaryRegex(lower).test(cleaned);
        const leetHit = lower !== deleet && wordBoundaryRegex(lower).test(deleet);
        if (rawHit || leetHit) {
            matches.push({ word: slur, cleaned, severity: "hate" });
        }
    }
    return matches.filter((m, i, arr) => arr.findIndex((x) => leetToText(x.word.toLowerCase()) === leetToText(m.word.toLowerCase())) === i);
}
