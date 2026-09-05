/**
 * Cloud Print Kiosk - WhatsApp Bot Agent (Baileys Direct Protocol Engine)
 * ------------------------------------------------------------------------
 * High-performance WhatsApp Bot powered by @whiskeysockets/baileys:
 * - Direct WhatsApp Multi-Device WebSocket Protocol
 * - Native PDF & Document Decryption (100% Reliable)
 * - Quick Print vs Customize Flow
 * - Automatic Direct Razorpay Link Checkout
 * - OTP Checked EXCLUSIVELY on Kiosk Display Panel
 * - 2-Minute Expiry Reminders for Unreleased Orders
 * - Automatic 7-Day Refund Coupon Code Generation on OTP Failure / Order Expiry
 * - Official PDF Document Receipt Generation & Delivery on Job Completion
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { PDFDocument, PageSizes, StandardFonts, rgb } = require('pdf-lib');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/json, text/plain, */*';

// Load optional bot_config.json if present
let botConfigFile = {};
const CONFIG_PATH = path.join(__dirname, 'bot_config.json');
if (fs.existsSync(CONFIG_PATH)) {
    try {
        botConfigFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.warn('⚠️ Warning: Could not parse bot_config.json:', e.message);
    }
}

// Parse optional CLI flags
let cliCollege = null;
const collegeArgIdx = process.argv.indexOf('--college');
if (collegeArgIdx !== -1 && process.argv[collegeArgIdx + 1]) {
    cliCollege = process.argv[collegeArgIdx + 1].trim();
}

let cliKey = null;
const keyArgIdx = process.argv.indexOf('--key');
if (keyArgIdx !== -1 && process.argv[keyArgIdx + 1]) {
    cliKey = process.argv[keyArgIdx + 1].trim();
}

let BOT_API_KEY = (cliKey || process.env.BOT_API_KEY || botConfigFile.botApiKey || '').trim();
let TARGET_COLLEGE = (cliCollege || process.env.TARGET_COLLEGE || botConfigFile.targetCollege || '').trim().toUpperCase();
let IS_DEDICATED_BOT = Boolean(TARGET_COLLEGE);

if (BOT_API_KEY) {
    axios.defaults.headers.common['X-Bot-Api-Key'] = BOT_API_KEY;
}

const shouldResetLogin = process.argv.includes('--reset-login') || process.argv.includes('--logout') || process.env.RESET_LOGIN === 'true';
const isQuietMode = process.argv.includes('--quiet') || process.argv.includes('--no-logs') || process.env.QUIET === 'true';
if (isQuietMode) {
    const rawLog = console.log;
    console.log = (...args) => {
        const text = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
        if (text.includes('QR CODE') || text.includes('Connected') || text.includes('Ready') || text.includes('Error') || text.includes('BOT MODE') || text.includes('SCAN THIS')) {
            rawLog(...args);
        }
    };
}

const BACKEND_BASE = process.env.BACKEND_BASE_URL || (botConfigFile.backendUrl ? botConfigFile.backendUrl.replace(/\/$/, '') : 'https://printer-backend-kgzp.onrender.com');
const BACKEND_URL = process.env.BACKEND_URL || `${BACKEND_BASE}/api/bot/direct-upload`;
const FRONTEND_BASE = process.env.FRONTEND_URL || botConfigFile.frontendUrl || 'https://cloudprint.website';
const SESSIONS_FILE = path.join(__dirname, 'user_sessions.json');

function getAuthDir() {
    return TARGET_COLLEGE ? path.join(__dirname, `.baileys_auth_${TARGET_COLLEGE.toLowerCase()}`) : path.join(__dirname, '.baileys_auth');
}
function getPrefsFile() {
    return TARGET_COLLEGE ? path.join(__dirname, `user_prefs_${TARGET_COLLEGE.toLowerCase()}.json`) : path.join(__dirname, 'user_prefs.json');
}

let AUTH_DIR = getAuthDir();
let PREFS_FILE = getPrefsFile();

if (shouldResetLogin && fs.existsSync(AUTH_DIR)) {
    console.log(`🧹 Removing login credentials directory: ${AUTH_DIR}...`);
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('✅ WhatsApp login credentials removed! A fresh QR code will be generated.\n');
    } catch (e) {
        console.warn('⚠️ Could not remove auth directory:', e.message);
    }
}

if (IS_DEDICATED_BOT) {
    console.log(`🏫 [DEDICATED BOT MODE] Initializing WhatsApp Agent exclusively for: *${TARGET_COLLEGE}*`);
} else {
    console.log('🌐 [UNIFIED BOT MODE] Initializing WhatsApp Agent in Multi-Campus Discovery Mode...');
}

// In-Memory Session Store with Sliding TTL & Auto-Garbage Collection (0 Disk I/O Bottleneck)
class SessionStore {
    constructor(ttlMinutes = 20) {
        this.ttlMs = ttlMinutes * 60 * 1000;
        this.sessions = new Map();
        this.bufferCache = new Map(); // JID -> { buffer, timestamp }
        this.userPrefs = new Map(); // JID -> { college, blockLocation, realPhoneNumber }
        this.loadPreferences();

        // Background TTL cleanup every 2 minutes
        setInterval(() => this.cleanupExpired(), 2 * 60 * 1000);
    }

    loadPreferences() {
        try {
            if (fs.existsSync(PREFS_FILE)) {
                const data = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
                for (const [key, val] of Object.entries(data)) {
                    this.userPrefs.set(key, val);
                }
            } else if (fs.existsSync(SESSIONS_FILE)) {
                // Migrate permanent preferences from legacy user_sessions.json once
                try {
                    const legacy = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
                    for (const [key, val] of Object.entries(legacy)) {
                        if (val.college || val.blockLocation || val.realPhoneNumber) {
                            this.userPrefs.set(key, {
                                college: val.college || null,
                                blockLocation: val.blockLocation || null,
                                realPhoneNumber: val.realPhoneNumber || val.phoneNumber || null
                            });
                        }
                    }
                    this.savePreferences();
                    console.log(`✅ Migrated ${this.userPrefs.size} user preferences to lightweight user_prefs.json`);
                } catch (migErr) {}
            }
        } catch (e) {
            console.error('Failed to load user preferences:', e.message);
        }
    }

    savePreferences() {
        try {
            const obj = {};
            for (const [key, val] of this.userPrefs.entries()) {
                obj[key] = val;
            }
            fs.writeFileSync(PREFS_FILE, JSON.stringify(obj, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to save user preferences:', e.message);
        }
    }

    getSession(jid) {
        let session = this.sessions.get(jid);
        if (!session) {
            const prefs = this.userPrefs.get(jid) || {};
            session = {
                jid,
                phoneNumber: prefs.realPhoneNumber || null,
                realPhoneNumber: prefs.realPhoneNumber || null,
                name: 'Student',
                college: IS_DEDICATED_BOT ? TARGET_COLLEGE : (prefs.college || null),
                blockLocation: (IS_DEDICATED_BOT && prefs.college && prefs.college.toUpperCase() !== TARGET_COLLEGE.toUpperCase()) ? null : (prefs.blockLocation || null),
                step: 'IDLE',
                pending: null,
                lastActivity: Date.now()
            };
            this.sessions.set(jid, session);
        } else {
            session.lastActivity = Date.now();
            if (IS_DEDICATED_BOT && session.college !== TARGET_COLLEGE) {
                session.college = TARGET_COLLEGE;
            }
        }
        return session;
    }

    setSession(jid, session) {
        if (!session) return;
        session.lastActivity = Date.now();
        this.sessions.set(jid, session);

        // Update preferences if college or block changed
        if (session.college || session.blockLocation || session.realPhoneNumber) {
            const currentPrefs = this.userPrefs.get(jid) || {};
            if (currentPrefs.college !== session.college ||
                currentPrefs.blockLocation !== session.blockLocation ||
                currentPrefs.realPhoneNumber !== session.realPhoneNumber) {
                this.userPrefs.set(jid, {
                    college: session.college || null,
                    blockLocation: session.blockLocation || null,
                    realPhoneNumber: session.realPhoneNumber || session.phoneNumber || null
                });
                this.savePreferences();
            }
        }
    }

    getAllSessions() {
        const obj = {};
        for (const [key, val] of this.sessions.entries()) {
            obj[key] = val;
        }
        return obj;
    }

    setBuffer(jid, buffer) {
        this.bufferCache.set(jid, { buffer, timestamp: Date.now() });
    }

    getBuffer(jid) {
        const entry = this.bufferCache.get(jid);
        return entry ? entry.buffer : null;
    }

    deleteBuffer(jid) {
        this.bufferCache.delete(jid);
    }

    cleanupExpired() {
        const now = Date.now();
        // 1. Purge expired document buffers (>15 mins)
        for (const [jid, entry] of this.bufferCache.entries()) {
            if (now - entry.timestamp > 15 * 60 * 1000) {
                this.bufferCache.delete(jid);
            }
        }

        // 2. Reset abandoned chat states (>20 mins idle and not waiting for paid order)
        for (const [jid, session] of this.sessions.entries()) {
            if (session.lastOrderId && !session.notifiedCompletion) {
                // Keep active if monitoring an active paid order
                continue;
            }
            if (now - (session.lastActivity || 0) > this.ttlMs) {
                if (session.step !== 'IDLE' || session.pending) {
                    session.step = 'IDLE';
                    session.pending = null;
                    this.deleteBuffer(jid);
                }
            }
        }
    }
}

const sessionStore = new SessionStore(20);

function loadSessions() {
    return sessionStore.getAllSessions();
}

function saveSessions(sessions) {
    if (!sessions) return;
    for (const [jid, s] of Object.entries(sessions)) {
        sessionStore.setSession(jid, s);
    }
}

// ==========================================
// Spam & Rate Limit Protection (Cooldown Mode)
// ==========================================
// Track invalid attempts per contact: JID -> { invalidCount: number, cooldownUntil: number }
const spamTracker = new Map();

function isContactInCooldown(jid) {
    if (!jid) return false;
    const tracker = spamTracker.get(jid);
    if (!tracker || !tracker.cooldownUntil) return false;
    if (Date.now() < tracker.cooldownUntil) {
        return true;
    }
    // 10-minute cooldown expired: reset
    tracker.cooldownUntil = 0;
    tracker.invalidCount = 0;
    return false;
}

function resetInvalidCount(jid) {
    if (!jid) return;
    const tracker = spamTracker.get(jid);
    if (tracker) {
        tracker.invalidCount = 0;
    }
}

async function recordInvalidAttempt(sock, jid, failureNotice) {
    if (!jid) return false;
    let tracker = spamTracker.get(jid);
    if (!tracker) {
        tracker = { invalidCount: 0, cooldownUntil: 0 };
        spamTracker.set(jid, tracker);
    }
    // If previous cooldown expired
    if (tracker.cooldownUntil && Date.now() >= tracker.cooldownUntil) {
        tracker.invalidCount = 0;
        tracker.cooldownUntil = 0;
    }

    tracker.invalidCount = (tracker.invalidCount || 0) + 1;
    console.warn(`⚠️ [RATE LIMIT] Contact ${jid} triggered invalid response (${tracker.invalidCount}/5).`);

    if (tracker.invalidCount >= 5) {
        tracker.cooldownUntil = Date.now() + 10 * 60 * 1000; // 10 minutes cooldown
        tracker.invalidCount = 0;
        console.warn(`⛔ [COOLDOWN TRIGGERED] Contact ${jid} placed in 10-minute cooldown.`);
        try {
            await sock.sendMessage(jid, {
                text: `⛔ *Account Temporarily Paused (5/5 Invalid Attempts)*\n\n` +
                      `You have exceeded the maximum of 5 invalid attempts.\n\n` +
                      `⏳ *Cooldown Active*: *10 Minutes*\n` +
                      `To maintain kiosk stability, the bot will *not reply* to any messages from this contact for the next 10 minutes.\n\n` +
                      `Please wait 10 minutes and try again with a valid file or command.`
            });
        } catch (e) {}
        return true; // Cooldown activated!
    }

    const remaining = 5 - tracker.invalidCount;
    const suffix = `\n\n⚠️ *(Attempt ${tracker.invalidCount}/5 — ${remaining} attempts remaining before 10-minute cooldown)*`;
    if (typeof failureNotice === 'string') {
        try {
            await sock.sendMessage(jid, { text: failureNotice + suffix });
        } catch (e) {}
    } else if (typeof failureNotice === 'function') {
        try {
            await failureNotice(suffix);
        } catch (e) {}
    }
    return false;
}

function isRecognizedFriendlyIntent(textLower) {
    if (!textLower) return false;
    const greetings = /^(hi|hello|hilo|hey|heya|hola|good morning|good afternoon|good evening|namaste|sup|what's up|greetings|start|menu)\b/i;
    const moodWeather = /rain|hot|cold|sunny|weather|tired|sleepy|hungry|morning|evening|night|day/i;
    const compliments = /love|smart|intelligent|best|cool|awesome|nice|good bot|sweet/i;
    const support = /paper jam|refund|stuck|failed|money|problem|issue|error|support/i;
    const howAreYou = /how are you|how do you do|hru|how's it going/i;
    const pricing = /price|cost|rate|tariff|how much|amount|charge|fee/i;
    const help = /help|how to|how it works|guide|instruction|step|process/i;
    const thanks = /thank|thanks|thx|ty|awesome|great|cool|perfect|good job|nice/i;
    const location = /where|location|kiosk|place|shop|address|block/i;
    const identity = /who are you|what are you|your name|bot|ai/i;
    const commands = /^(cancel|receipt|invoice|bill|status|balance|cb|cc|alert)\b/i;

    return greetings.test(textLower) ||
           moodWeather.test(textLower) ||
           compliments.test(textLower) ||
           support.test(textLower) ||
           howAreYou.test(textLower) ||
           pricing.test(textLower) ||
           help.test(textLower) ||
           thanks.test(textLower) ||
           location.test(textLower) ||
           identity.test(textLower) ||
           commands.test(textLower);
}

let cachedCollegesMap = null;
let lastCollegesFetchTime = 0;

async function getCollegesAndBlocks() {
    const now = Date.now();
    // Cache for 30 seconds so online printer availability is fresh and responsive
    if (cachedCollegesMap && (now - lastCollegesFetchTime < 30 * 1000)) {
        return cachedCollegesMap;
    }

    try {
        let res = null;
        try {
            res = await axios.get(`${BACKEND_BASE}/api/blocks/online`, { timeout: 15000 });
        } catch (e) {}
        if (!res || !res.data || !Array.isArray(res.data) || res.data.length === 0) {
            try {
                res = await axios.get(`${BACKEND_BASE}/api/blocks`, { timeout: 15000 });
            } catch (e) {}
        }
        if (res && res.data && Array.isArray(res.data) && res.data.length > 0) {
            const map = {};
            res.data.forEach(item => {
                const col = (item.college || 'Campus').trim();
                if (!map[col]) map[col] = [];
                if (item.name && !map[col].includes(item.name)) {
                    map[col].push(item.name);
                }
            });

            if (IS_DEDICATED_BOT) {
                // Return only blocks for TARGET_COLLEGE (case-insensitive lookup)
                const targetKey = Object.keys(map).find(k => k.trim().toUpperCase() === TARGET_COLLEGE.toUpperCase()) || TARGET_COLLEGE;
                const dedicatedMap = {};
                dedicatedMap[TARGET_COLLEGE] = map[targetKey] || [];
                cachedCollegesMap = dedicatedMap;
                lastCollegesFetchTime = now;
                return dedicatedMap;
            }

            cachedCollegesMap = map;
            lastCollegesFetchTime = now;
            return map;
        }
    } catch (e) {
        console.error('Online blocks lookup notice (using cache):', e.message);
    }

    if (cachedCollegesMap) return cachedCollegesMap;

    if (IS_DEDICATED_BOT) {
        return {
            [TARGET_COLLEGE]: ["C Block"]
        };
    }

    return {
        "KLU": ["C Block"]
    };
}

const printerStatusCache = new Map();

async function checkKioskPrinterStatus(blockLocation, printType = 'BW') {
    if (!blockLocation) return { available: false, message: 'No kiosk block specified' };
    const cacheKey = `${blockLocation}_${printType}`;
    const cached = printerStatusCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp < 30000)) {
        return cached.result;
    }

    try {
        const res = await axios.get(`${BACKEND_BASE}/api/printer/availability?blockLocation=${encodeURIComponent(blockLocation)}&printType=${printType}`, { timeout: 8000 });
        if (res.data) {
            const result = {
                available: Boolean(res.data.available),
                message: res.data.message || (res.data.available ? 'Printer is available' : 'The printer at this block is currently offline or unassigned.')
            };
            printerStatusCache.set(cacheKey, { timestamp: now, result });
            return result;
        }
    } catch (e) {
        if (!e.message.includes('503') && !e.message.includes('429')) {
            console.error(`Printer status check notice for ${blockLocation}:`, e.message);
        }
    }

    const fallback = { available: true, message: 'Printer is available' };
    return cached ? cached.result : fallback;
}

async function getKioskPaperCount(blockLocation) {
    if (!blockLocation) return 500;
    try {
        const res = await axios.get(`${BACKEND_BASE}/api/printer/paper?blockLocation=${encodeURIComponent(blockLocation)}`, { timeout: 6000 });
        if (res.data !== undefined && res.data !== null && !isNaN(Number(res.data))) {
            return Number(res.data);
        }
    } catch (e) {
        console.error(`Paper count fetch notice for ${blockLocation}:`, e.message);
    }
    return 500;
}

async function sendDirectAdminAlert(sockInstance, text) {
    if (!sockInstance) return;
    const adminPhones = ['919494189664', '918688500278'];
    for (const phone of adminPhones) {
        try {
            const targetJid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            await sockInstance.sendMessage(targetJid, { text });
            console.log(`📱 Hardware/Paper alert delivered to Admin WhatsApp (+${phone})`);
        } catch (e) {
            console.error(`Failed to dispatch alert to Admin (+${phone}):`, e.message);
        }
    }
}

function getPDFPageCount(buffer) {
    try {
        const text = buffer.toString('latin1');
        const matches = text.match(/\/Type\s*\/Page\b/g);
        if (matches && matches.length > 0) {
            return matches.length;
        }
        const countMatch = text.match(/\/Count\s+(\d+)/);
        if (countMatch && countMatch[1]) {
            return parseInt(countMatch[1], 10);
        }
    } catch (e) {}
    return 1;
}

function countPagesFromRange(rangeStr, totalPages) {
    if (!rangeStr || rangeStr.toUpperCase() === 'ALL' || rangeStr === '1') {
        return totalPages;
    }
    try {
        if (rangeStr.includes('-')) {
            const parts = rangeStr.split('-');
            const start = parseInt(parts[0].trim(), 10);
            const end = parseInt(parts[1].trim(), 10);
            if (!isNaN(start) && !isNaN(end) && start <= end) {
                return Math.min(end, totalPages) - Math.max(1, start) + 1;
            }
        } else if (rangeStr.includes(',')) {
            const pages = rangeStr.split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
            return pages.length > 0 ? pages.length : totalPages;
        } else {
            const single = parseInt(rangeStr.trim(), 10);
            if (!isNaN(single)) return 1;
        }
    } catch (e) {}
    return totalPages;
}

function isValidPageRange(rangeStr, totalPages) {
    if (!rangeStr) return false;
    const str = rangeStr.trim().toLowerCase();
    if (str === 'all' || str === '1') return true;

    try {
        if (str.includes('-')) {
            const parts = str.split('-');
            if (parts.length !== 2) return false;
            const start = parseInt(parts[0].trim(), 10);
            const end = parseInt(parts[1].trim(), 10);
            if (isNaN(start) || isNaN(end)) return false;
            if (start < 1 || end < start || end > totalPages) return false;
            return true;
        } else if (str.includes(',')) {
            const parts = str.split(',');
            if (parts.length === 0) return false;
            for (const p of parts) {
                const num = parseInt(p.trim(), 10);
                if (isNaN(num) || num < 1 || num > totalPages) return false;
            }
            return true;
        } else {
            const num = parseInt(str, 10);
            if (isNaN(num) || num < 1 || num > totalPages) return false;
            return true;
        }
    } catch (e) {
        return false;
    }
}

async function transformPdfToNUp(inputBuffer, layoutMode = '2-UP') {
    if (!layoutMode || layoutMode === '1-UP') {
        return inputBuffer;
    }

    try {
        const srcDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
        const srcPageCount = srcDoc.getPageCount();
        if (srcPageCount === 0) return inputBuffer;

        const newDoc = await PDFDocument.create();
        const [a4Width, a4Height] = PageSizes.A4; // 595.28 x 841.89

        // Embed all source pages
        const embeddedPages = await newDoc.embedPages(srcDoc.getPages());

        if (layoutMode === '2-UP') {
            // 2-Up Mode: 2 slides per A4 Portrait page (top & bottom stacked)
            // or 2 portrait pages per A4 Landscape page (left & right side-by-side)
            const firstPage = srcDoc.getPage(0);
            const isSourceLandscape = firstPage.getWidth() > firstPage.getHeight();

            const sheetWidth = isSourceLandscape ? a4Width : a4Height;
            const sheetHeight = isSourceLandscape ? a4Height : a4Width;

            const margin = 20;
            const gap = 14;

            for (let i = 0; i < srcPageCount; i += 2) {
                const page = newDoc.addPage([sheetWidth, sheetHeight]);

                const slots = isSourceLandscape ? [
                    // Top slot
                    {
                        x: margin,
                        y: (sheetHeight / 2) + (gap / 2),
                        w: sheetWidth - (2 * margin),
                        h: (sheetHeight / 2) - margin - (gap / 2)
                    },
                    // Bottom slot
                    {
                        x: margin,
                        y: margin,
                        w: sheetWidth - (2 * margin),
                        h: (sheetHeight / 2) - margin - (gap / 2)
                    }
                ] : [
                    // Left slot
                    {
                        x: margin,
                        y: margin,
                        w: (sheetWidth / 2) - margin - (gap / 2),
                        h: sheetHeight - (2 * margin)
                    },
                    // Right slot
                    {
                        x: (sheetWidth / 2) + (gap / 2),
                        y: margin,
                        w: (sheetWidth / 2) - margin - (gap / 2),
                        h: sheetHeight - (2 * margin)
                    }
                ];

                // Render Page 1 of pair
                drawPageInSlot(page, embeddedPages[i], slots[0]);

                // Render Page 2 of pair (if available)
                if (i + 1 < srcPageCount) {
                    drawPageInSlot(page, embeddedPages[i + 1], slots[1]);
                }

                // Draw subtle divider line
                if (isSourceLandscape) {
                    page.drawLine({
                        start: { x: margin, y: sheetHeight / 2 },
                        end: { x: sheetWidth - margin, y: sheetHeight / 2 },
                        thickness: 0.5,
                        color: rgb(0.8, 0.8, 0.8),
                        dashArray: [4, 4]
                    });
                } else {
                    page.drawLine({
                        start: { x: sheetWidth / 2, y: margin },
                        end: { x: sheetWidth / 2, y: sheetHeight - margin },
                        thickness: 0.5,
                        color: rgb(0.8, 0.8, 0.8),
                        dashArray: [4, 4]
                    });
                }
            }
        } else if (layoutMode === '4-UP') {
            // 4-Up Mode: 4 slides in a 2x2 grid
            const firstPage = srcDoc.getPage(0);
            const isSourceLandscape = firstPage.getWidth() > firstPage.getHeight();

            const sheetWidth = isSourceLandscape ? a4Height : a4Width; // 841.89 x 595.28 for landscape slides
            const sheetHeight = isSourceLandscape ? a4Width : a4Height;

            const margin = 16;
            const gap = 12;
            const cellW = (sheetWidth - (2 * margin) - gap) / 2;
            const cellH = (sheetHeight - (2 * margin) - gap) / 2;

            for (let i = 0; i < srcPageCount; i += 4) {
                const page = newDoc.addPage([sheetWidth, sheetHeight]);

                const slots = [
                    // Top-Left (Row 1, Col 1)
                    { x: margin, y: margin + cellH + gap, w: cellW, h: cellH },
                    // Top-Right (Row 1, Col 2)
                    { x: margin + cellW + gap, y: margin + cellH + gap, w: cellW, h: cellH },
                    // Bottom-Left (Row 2, Col 1)
                    { x: margin, y: margin, w: cellW, h: cellH },
                    // Bottom-Right (Row 2, Col 2)
                    { x: margin + cellW + gap, y: margin, w: cellW, h: cellH }
                ];

                for (let j = 0; j < 4; j++) {
                    if (i + j < srcPageCount) {
                        drawPageInSlot(page, embeddedPages[i + j], slots[j]);
                    }
                }

                // Grid dividers
                page.drawLine({
                    start: { x: margin, y: sheetHeight / 2 },
                    end: { x: sheetWidth - margin, y: sheetHeight / 2 },
                    thickness: 0.5,
                    color: rgb(0.8, 0.8, 0.8),
                    dashArray: [3, 3]
                });
                page.drawLine({
                    start: { x: sheetWidth / 2, y: margin },
                    end: { x: sheetWidth / 2, y: sheetHeight - margin },
                    thickness: 0.5,
                    color: rgb(0.8, 0.8, 0.8),
                    dashArray: [3, 3]
                });
            }
        }

        const outputBytes = await newDoc.save();
        return Buffer.from(outputBytes);
    } catch (err) {
        console.error('transformPdfToNUp error, fallback to original buffer:', err.message);
        return inputBuffer;
    }
}

function drawPageInSlot(page, embeddedPage, slot) {
    const pW = embeddedPage.width;
    const pH = embeddedPage.height;

    // Calculate scale factor while maintaining aspect ratio
    const scale = Math.min(slot.w / pW, slot.h / pH);
    const drawW = pW * scale;
    const drawH = pH * scale;

    // Center within slot
    const posX = slot.x + (slot.w - drawW) / 2;
    const posY = slot.y + (slot.h - drawH) / 2;

    // Draw subtle border around slide tile
    page.drawRectangle({
        x: posX,
        y: posY,
        width: drawW,
        height: drawH,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 0.75,
        color: undefined // transparent fill
    });

    // Draw embedded page
    page.drawPage(embeddedPage, {
        x: posX,
        y: posY,
        width: drawW,
        height: drawH
    });
}

async function createUploadFormData(session, senderName, senderPhone) {
    let buffer = sessionStore.getBuffer(session.jid || senderPhone) ||
                 (session.pending?.bufferBase64 ? Buffer.from(session.pending.bufferBase64, 'base64') : null);

    // Apply Student Saver N-Up transformation if selected
    if (buffer && session.pending && session.pending.layoutMode && session.pending.layoutMode !== '1-UP' && !session.pending.isImage) {
        console.log(`📑 Transforming document to ${session.pending.layoutMode} Layout for student ${senderPhone}...`);
        buffer = await transformPdfToNUp(buffer, session.pending.layoutMode);
    }

    const form = new FormData();
    form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype || 'application/pdf' });
    form.append('customerName', `${senderName} (${senderPhone})`);
    form.append('phoneNumber', senderPhone);
    form.append('blockLocation', session.blockLocation || 'Campus Kiosk');
    form.append('printType', session.pending.printType || 'BW');
    form.append('selectedPages', session.pending.selectedPages || 'ALL');
    form.append('doubleSided', session.pending.doubleSided ? 'true' : 'false');
    form.append('copies', String(session.pending.copies || 1));
    const activeCoupon = session.pending.couponCode || session.savedDiscountCoupon?.code;
    if (activeCoupon) {
        form.append('couponCode', activeCoupon);
    }
    return form;
}

function getFriendlyChatResponse(textLower, rawText, senderName, session) {
    // 1. Weather, Day & Mood Scenarios
    if (/rain|hot|cold|sunny|weather|tired|sleepy|hungry|morning|evening|night|day/i.test(textLower)) {
        return `☀️ *Hope you're having a great day, ${senderName}!* 😊\n\n` +
               `Whether it's a busy day of lectures or a relaxed evening, take care of yourself! 🧃✨\n\n` +
               `Whenever you need study materials or documents printed, I'm ready 24/7 at *${session.blockLocation || 'your campus kiosk'}*! 🖨️`;
    }

    // 2. Compliments & Positive Energy
    if (/love|smart|intelligent|best|cool|awesome|nice|good bot|sweet/i.test(textLower)) {
        return `🥰 *Aww, thank you so much, ${senderName}!* You're super awesome too! 🌟✨\n\n` +
               `I'm always here to give you the best printing experience possible. Let me know if you need anything printed today! 🖨️❤️`;
    }

    // 3. Support, Refunds & Kiosk Issues
    if (/paper jam|refund|stuck|failed|money|problem|issue|error/i.test(textLower)) {
        return `🛠️ *Cloud Print Support & Refunds* 😊\n\n` +
               `• *OTP / Expiry Refund*: If an order expires before OTP entry, a 7-day refund coupon is automatically generated and sent to you right here!\n` +
               `• *Kiosk Support*: Our team is available on the campus desk.\n` +
               `• *Email*: support@cloudprint.edu\n\n` +
               `If you face any issue, reply *"cancel"* to cancel an active draft, or ask me anything! 💬`;
    }

    // 4. Greetings & Friendly Small Talk
    if (/^(hi|hello|hilo|hey|heya|hola|good morning|good afternoon|good evening|namaste|sup|what's up|greetings)/i.test(textLower)) {
        return `👋 *Hello ${senderName}!* 😊\n\n` +
               `I'm your **Cloud Print Assistant**! I'm here to support you and manage your print jobs smoothly.\n\n` +
               `📍 *Active Online Kiosk*: *${session.blockLocation || 'C Block'}* (🟢 Online & Active 🖨️)\n` +
               `🏫 *Campus*: *${session.college || 'KLU'}*\n\n` +
               `📎 *To Print*: Simply attach and send any **PDF document or Image** right here in chat!\n` +
               `💡 Reply *"block"* anytime to switch your kiosk or check online printer status.`;
    }

    // 5. Friendly "How are you"
    if (/how are you|how do you do|hru|how's it going/i.test(textLower)) {
        return `😊 *I'm doing awesome, thank you for asking, ${senderName}!* 🌟\n\nReady to help you print your documents fast and hassle-free at *${session.blockLocation || 'C Block'}* (🟢 Online). Just send your file whenever you're ready! 🖨️✨`;
    }

    // 6. Pricing & Rates
    if (/price|cost|rate|tariff|how much|amount|charge|fee/i.test(textLower)) {
        return `💰 *Cloud Print Tariff Schedule* 😊\n` +
               `-----------------------------------\n` +
               `• 📄 *Black & White*: ₹2.00 / page\n` +
               `• 🎨 *Full Color*: ₹5.00 / page\n` +
               `• 📑 *Both Sides (Duplex)*: Supported for B&W prints!\n\n` +
               `Send any file now and I'll calculate the exact total estimate for you before you pay! 📊`;
    }

    // 7. Instructions & How it works
    if (/help|how to|how it works|guide|instruction|step|process/i.test(textLower)) {
        return `✨ *How to Print in 3 Easy Steps* 🚀\n` +
               `-----------------------------------\n` +
               `1️⃣ *Send File*: Attach your PDF or Image in this WhatsApp chat.\n` +
               `2️⃣ *Select Settings*: Choose pages & color mode, then pay online.\n` +
               `3️⃣ *Collect Print*: Look at the TV Display Screen at *${session.blockLocation || 'C Block'}* for your 4-digit OTP, then reply with the code here in WhatsApp to release your print directly to the printer tray!\n\n` +
               `It's super simple! Just send your file to begin. 😊`;
    }

    // 8. Thank you & Appreciation
    if (/thank|thanks|thx|ty|awesome|great|cool|perfect|good job|nice/i.test(textLower)) {
        return `🥰 *You're very welcome, ${senderName}!* Happy to help! 🎉\n\nHave a wonderful day, and enjoy your prints! 🖨️✨`;
    }

    // 9. Kiosk Location Info
    if (/where|location|kiosk|place|shop|address|block/i.test(textLower)) {
        return `📍 *Kiosk Info* 😊\n` +
               `-----------------------------------\n` +
               `• 🏫 *College/Shop*: *${session.college || 'Selected Campus'}*\n` +
               `• 🖨️ *Active Kiosk*: *${session.blockLocation || 'Selected Kiosk'}* (🟢 Online)\n\n` +
               `Your documents will be printed at this location! 🚀 Reply *"block"* to switch anytime.`;
    }

    // 10. Bot Identity / Who are you
    if (/who are you|what are you|your name|bot|ai/i.test(textLower)) {
        return `🤖 *I'm your Cloud Print WhatsApp Assistant!* 😊\n\nI'm here to make document printing at your campus kiosk instant, 100% digital, and completely hassle-free! 🖨️⚡`;
    }

    // Default Conversational Fallback
    return `👋 *Hi ${senderName}!* 😊\n\n` +
           `I'm here to help with your campus document printing.\n\n` +
           `📍 *Active Online Kiosk*: *${session.blockLocation || 'C Block'}* (🟢 Online & Ready 🖨️)\n` +
           `🏫 *Campus*: *${session.college || 'KLU'}*\n\n` +
           `📎 *To Print*: Simply attach and send any **PDF document or Image** right here!\n` +
           `💡 Reply *"block"* anytime to check online printers or switch kiosk! ✨`;
}

async function generateRefundCoupon(paidAmount) {
    const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const amountVal = typeof paidAmount === 'number' ? paidAmount : (parseFloat(paidAmount) || 2.0);
    try {
        const res = await axios.post(`${BACKEND_BASE}/api/coupon/refund?amount=${amountVal}&code=${randomCode}`, null, { timeout: 15000 });
        if (res.data && res.data.couponCode) {
            return res.data.couponCode;
        }
        return randomCode;
    } catch (e) {
        console.error("Failed to create refund coupon via /refund endpoint:", e.message);
        try {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 7);
            const expiryStr = expiry.toISOString().split('T')[0];
            const payload = {
                couponCode: randomCode,
                discountAmount: amountVal,
                discountPercentage: 0.0,
                expiryDate: expiryStr,
                maxUses: 1,
                usedCount: 0,
                active: true
            };
            const res2 = await axios.post(`${BACKEND_BASE}/api/coupon/create`, payload, { timeout: 15000 });
            if (res2.data && res2.data.couponCode) {
                return res2.data.couponCode;
            }
        } catch (e2) {
            console.error("Failed to create refund coupon via /create endpoint:", e2.message);
        }
        return randomCode;
    }
}

async function createReceiptPdf(orderData) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const { width, height } = page.getSize();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const primaryColor = rgb(0.01, 0.52, 0.78); // Cyan / Blue branding
    const darkTextColor = rgb(0.08, 0.12, 0.18);
    const mutedTextColor = rgb(0.45, 0.52, 0.60);
    const borderColor = rgb(0.88, 0.92, 0.96);
    const greenColor = rgb(0.09, 0.63, 0.34);

    // 1. Outer Container Card Border
    page.drawRectangle({
        x: 35,
        y: 35,
        width: width - 70,
        height: height - 70,
        color: rgb(1, 1, 1),
        borderColor: borderColor,
        borderWidth: 1.5,
    });

    // Top Accent Bar
    page.drawRectangle({
        x: 35,
        y: height - 43,
        width: width - 70,
        height: 8,
        color: primaryColor,
    });

    // 2. Watermark Background Stamp
    page.drawText('VERIFIED', {
        x: 160,
        y: height / 2 - 20,
        size: 64,
        font: fontBold,
        color: rgb(0.96, 0.97, 0.98),
        rotate: { type: 'degrees', angle: 30 },
    });

    // 3. Header Section
    page.drawText('CLOUD PRINT KIOSK', {
        x: 60,
        y: height - 85,
        size: 22,
        font: fontBold,
        color: primaryColor,
    });

    page.drawText('Self-Service Campus Print Network · Digital Invoice', {
        x: 60,
        y: height - 105,
        size: 10,
        font: fontRegular,
        color: mutedTextColor,
    });

    // Header Right: Title & Stamp
    page.drawText('PAYMENT RECEIPT', {
        x: width - 230,
        y: height - 85,
        size: 16,
        font: fontBold,
        color: darkTextColor,
    });

    // Green Verified Pill
    page.drawRectangle({
        x: width - 230,
        y: height - 112,
        width: 170,
        height: 20,
        color: rgb(0.92, 0.98, 0.94),
        borderColor: greenColor,
        borderWidth: 1,
    });

    page.drawText('PAID & AUTHENTICATED', {
        x: width - 215,
        y: height - 106,
        size: 9,
        font: fontBold,
        color: greenColor,
    });

    // Divider Line 1
    page.drawLine({
        start: { x: 60, y: height - 128 },
        end: { x: width - 60, y: height - 128 },
        thickness: 1,
        color: borderColor,
    });

    let currentY = height - 155;

    // Helper: Draw Section Title
    const drawSectionTitle = (title) => {
        page.drawText(title, {
            x: 60,
            y: currentY,
            size: 11,
            font: fontBold,
            color: primaryColor,
        });
        currentY -= 20;
    };

    // Helper: Draw 2-column key-value row
    const drawKeyValue = (key, val, isHighlight = false) => {
        page.drawText(key, {
            x: 60,
            y: currentY,
            size: 10,
            font: fontBold,
            color: mutedTextColor,
        });
        page.drawText(String(val), {
            x: 230,
            y: currentY,
            size: 10,
            font: isHighlight ? fontBold : fontRegular,
            color: isHighlight ? darkTextColor : darkTextColor,
        });
        currentY -= 20;
    };

    // Section 1: Transaction Details
    drawSectionTitle('TRANSACTION DETAILS');
    drawKeyValue('Order ID:', orderData.orderId || 'ORD2026', true);
    drawKeyValue('Receipt Date:', orderData.paidAt ? new Date(orderData.paidAt).toLocaleString() : new Date().toLocaleString());

    const origPrice = Number(orderData.originalPrice != null ? orderData.originalPrice : (orderData.price || 0));
    const discount = Number(orderData.discountAmount || 0);
    let finalPrice = Number(orderData.price != null ? orderData.price : Math.max(0, origPrice - discount));
    if (discount > 0 && finalPrice === origPrice && origPrice > 0) {
        finalPrice = Math.max(0, origPrice - discount);
    }
    const isCouponOrFree = finalPrice <= 0 || (discount >= origPrice && origPrice > 0);

    let txId = orderData.transactionId || 'WALLET';
    let paymentChannel = orderData.paymentMethod || 'WhatsApp Cloud Print';
    if (isCouponOrFree) {
        txId = 'COUPON PAYMENT (₹0.00 PAID)';
        paymentChannel = 'Coupon / 100% Wallet Discount';
    } else if (txId === 'WALLET' || txId === 'WALLET_PAYMENT') {
        txId = 'WALLET_BALANCE';
        paymentChannel = 'Student Print Wallet';
    }

    drawKeyValue('Transaction ID:', txId);
    drawKeyValue('Payment Channel:', paymentChannel);
    drawKeyValue('Collection Kiosk:', orderData.blockLocation || 'C Block Kiosk', true);

    currentY -= 8;
    page.drawLine({
        start: { x: 60, y: currentY },
        end: { x: width - 60, y: currentY },
        thickness: 1,
        color: borderColor,
    });
    currentY -= 22;

    // Section 2: Document Specifications
    drawSectionTitle('DOCUMENT SPECIFICATIONS');
    const safeFileName = orderData.fileName && orderData.fileName.length > 40 ? orderData.fileName.substring(0, 37) + '...' : (orderData.fileName || 'Document.pdf');
    drawKeyValue('File Name:', safeFileName, true);
    drawKeyValue('Color Mode:', orderData.printType === 'COLOR' ? 'Full Color (High Quality)' : 'Black & White (B&W)');
    drawKeyValue('Print Sides:', orderData.doubleSided ? 'Double Sided (Duplex)' : 'Single Sided (Simplex)');
    drawKeyValue('Total Document Pages:', `${orderData.totalPages || 1} page(s)`);
    drawKeyValue('Number of Copies:', `${orderData.copies || 1} copy(ies)`);

    currentY -= 8;
    page.drawLine({
        start: { x: 60, y: currentY },
        end: { x: width - 60, y: currentY },
        thickness: 1,
        color: borderColor,
    });
    currentY -= 22;

    // Section 3: Payment Breakdown (Card Box)
    drawSectionTitle('PAYMENT BREAKDOWN');

    const boxY = currentY - 75;
    page.drawRectangle({
        x: 60,
        y: boxY,
        width: width - 120,
        height: 85,
        color: isCouponOrFree ? rgb(0.95, 0.99, 0.96) : rgb(0.97, 0.98, 1),
        borderColor: isCouponOrFree ? rgb(0.75, 0.92, 0.80) : rgb(0.85, 0.90, 0.98),
        borderWidth: 1,
    });

    const displayDiscount = discount > 0 ? discount : (isCouponOrFree ? origPrice : 0);

    page.drawText('Original Amount:', { x: 80, y: boxY + 60, size: 10, font: fontRegular, color: mutedTextColor });
    page.drawText(`Rs. ${Number(origPrice).toFixed(2)}`, { x: width - 180, y: boxY + 60, size: 10, font: fontRegular, color: darkTextColor });

    page.drawText(isCouponOrFree ? 'Coupon / Wallet Discount:' : 'Discount / Wallet Applied:', { x: 80, y: boxY + 40, size: 10, font: fontRegular, color: greenColor });
    page.drawText(`- Rs. ${Number(displayDiscount).toFixed(2)}`, { x: width - 180, y: boxY + 40, size: 10, font: fontBold, color: greenColor });

    page.drawLine({
        start: { x: 80, y: boxY + 30 },
        end: { x: width - 80, y: boxY + 30 },
        thickness: 0.5,
        color: rgb(0.8, 0.85, 0.9),
    });

    page.drawText('Total Paid:', { x: 80, y: boxY + 12, size: 12, font: fontBold, color: isCouponOrFree ? greenColor : primaryColor });
    const totalPaidText = isCouponOrFree ? 'Rs. 0.00 (Coupon Payment)' : `Rs. ${Number(finalPrice).toFixed(2)}`;
    page.drawText(totalPaidText, { x: width - (isCouponOrFree ? 230 : 180), y: boxY + 12, size: 12, font: fontBold, color: isCouponOrFree ? greenColor : primaryColor });

    // Section 4: Footer
    page.drawRectangle({
        x: 60,
        y: 60,
        width: width - 120,
        height: 60,
        color: rgb(0.98, 0.99, 1),
        borderColor: borderColor,
        borderWidth: 1,
    });

    page.drawText('Thank you for using Cloud Print Self-Service Kiosks!', {
        x: 160,
        y: 95,
        size: 11,
        font: fontBold,
        color: primaryColor,
    });

    page.drawText('This is a system generated digital invoice. No physical signature is required.', {
        x: 125,
        y: 75,
        size: 8.5,
        font: fontRegular,
        color: mutedTextColor,
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

async function sendSmartMenu(sock, targetJid, title, bodyText, footerText, buttonList) {
    try {
        let menuText = `*${title || '🖨️ Cloud Print Kiosk'}*\n\n${bodyText}`;
        if (buttonList && buttonList.length > 0) {
            menuText += `\n\n`;
            buttonList.forEach((btn, i) => {
                const label = typeof btn === 'string' ? btn : (btn.body || btn.id || String(btn));
                menuText += `${i + 1}️⃣  ${label}\n`;
            });
            menuText += `\n👉 *Reply with the number (e.g. 1 or 2)*`;
        }
        await sock.sendMessage(targetJid, { text: menuText });
    } catch (err) {
        console.error("sendSmartMenu error:", err);
    }
}

async function processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessionsInput) {
    const sessions = sessionsInput || loadSessions();
    await sock.sendMessage(jid, { text: "⏳ *Processing your order with print kiosk server...*" });

    let resData;
    try {
        const remoteForm = await createUploadFormData(session, senderName, senderPhone);
        const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
        const response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
        resData = response.data || {};
        sessionStore.deleteBuffer(session.jid || senderPhone);
    } catch (remoteErr) {
        console.error("Order creation failed on backend:", remoteErr.message);
        session.pending = null;
        session.step = 'IDLE';
        saveSessions(sessions);

        if (remoteErr.code === 'ECONNABORTED' || remoteErr.message.includes('timeout')) {
            await sock.sendMessage(jid, { 
                text: "❌ *Transaction Failed (5-Min Timeout)*\n\nThe print server did not wake up or respond within 5 minutes.\n\nYour order has been cancelled and not charged. Please try again shortly." 
            });
        } else {
            const errorMsg = (typeof remoteErr.response?.data === 'string' && remoteErr.response.data)
                ? remoteErr.response.data
                : (remoteErr.response?.data?.message || "❌ *Transaction Failed*: Could not create order on server. Please try again.");
            await sock.sendMessage(jid, { text: errorMsg });
        }
        return;
    }

    const orderId = resData.orderId || 'ORD2026';
    const userOtp = resData.otp || '';
    const expiryDate = new Date(Date.now() + 10 * 60 * 1000);
    const expiryTimeStr = expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

    if (resData.paidViaWallet) {
        const paidMsg = `✅ *Payment Successful via Wallet Balance!* 🎉\n` +
                        `-----------------------------------\n` +
                        `💰 *Amount Paid*: *₹${(resData.estimatedTotal || estimatedTotal).toFixed(2)}*\n` +
                        `💳 *Remaining Wallet Balance*: *₹${(resData.newBalance || 0.0).toFixed(2)}*\n` +
                        `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                        `📺 *Release OTP*: Look at the *${session.blockLocation || 'Campus Kiosk'} TV Display Screen* for your 4-digit OTP\n` +
                        `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                        `👉 *Once you see your 4-digit code on the TV screen, reply with it here in WhatsApp to release your print!*`;

        await sock.sendMessage(jid, { text: paidMsg });

        session.lastOrderId = orderId;
        session.lastOtp = userOtp;
        session.lastPrice = resData.estimatedTotal || estimatedTotal;
        session.otpReleased = false;
        session.paymentNotified = true;
        session.paidTimestamp = Date.now();
        session.lastReminderTimestamp = Date.now();
        session.pending = null;
        session.step = 'IDLE';
        saveSessions(sessions);
        return;
    } else if (resData.partialWallet) {
        const paymentUrl = resData.paymentUrl || `${FRONTEND_BASE}/pay?orderId=${orderId}`;
        const payMsg = `💳 *Partial Wallet Payment Applied* (-₹${Number(resData.walletDeducted || 0).toFixed(2)})\n` +
                     `💰 *Remaining Amount to Pay*: *₹${Number(resData.finalPriceToPay || estimatedTotal).toFixed(2)}*\n\n` +
                     `💳 *Pay Remaining Online via Razorpay*:\n${paymentUrl}\n\n` +
                     `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                     `📺 *Release OTP*: Look at the *Kiosk TV Display Screen* after completing payment\n` +
                     `⏳ *Payment Window*: *5 Minutes*\n\n` +
                     `Tap the link above to complete your UPI/Card payment! Once paid, look at the TV Display screen for your 4-digit OTP and reply with it here in WhatsApp to print at *${session.blockLocation || 'your campus kiosk'}*!`;

        await sock.sendMessage(jid, { text: payMsg });

        session.lastOrderId = orderId;
        session.lastOtp = userOtp;
        session.lastPrice = resData.finalPriceToPay;
        session.otpReleased = false;
        session.paymentNotified = false;
        session.notifiedCompletion = false;
        session.notifiedCancelled = false;
        session.orderCreatedTimestamp = Date.now();
        session.paidTimestamp = null;
        session.lastReminderTimestamp = 0;
        session.pending = null;
        session.step = 'IDLE';
        saveSessions(sessions);
        return;
    } else {
        const paymentUrl = resData.paymentUrl || `${FRONTEND_BASE}/pay?orderId=${orderId}`;
        const payMsg = `💳 *Pay Online via Razorpay*:\n${paymentUrl}\n\n` +
                     `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                     `📺 *Release OTP*: Look at the *Kiosk TV Display Screen* after payment\n` +
                     `⏳ *Payment Window*: *5 Minutes*\n\n` +
                     `Tap the link above to complete your UPI/Card payment! Once paid, look at the TV Display screen for your 4-digit OTP and reply with it here in WhatsApp to print at *${session.blockLocation || 'your campus kiosk'}*!`;

        await sock.sendMessage(jid, { text: payMsg });

        session.lastOrderId = orderId;
        session.lastOtp = userOtp;
        session.lastPrice = estimatedTotal;
        session.otpReleased = false;
        session.paymentNotified = false;
        session.notifiedCompletion = false;
        session.notifiedCancelled = false;
        session.orderCreatedTimestamp = Date.now();
        session.paidTimestamp = null;
        session.lastReminderTimestamp = 0;
        session.pending = null;
        session.step = 'IDLE';
        saveSessions(sessions);
        return;
    }
}

let sock = null;
let isBotInitialized = false;

async function verifyBotApiKey() {
    if (!BOT_API_KEY) return;
    try {
        console.log(`🔑 [DEDICATED KEY] Validating WhatsApp Bot API Key with backend...`);
        const res = await axios.get(`${BACKEND_BASE}/api/college-config/verify-bot-key?key=${encodeURIComponent(BOT_API_KEY)}`, { timeout: 8000 });
        if (res.data && res.data.valid && res.data.college) {
            TARGET_COLLEGE = res.data.college.trim().toUpperCase();
            IS_DEDICATED_BOT = true;
            AUTH_DIR = getAuthDir();
            PREFS_FILE = getPrefsFile();
            console.log(`✅ [DEDICATED KEY VERIFIED] Authenticated successfully! Auto-locked to Campus: *${TARGET_COLLEGE}*`);
        } else {
            console.warn(`⚠️ Warning: Dedicated Bot Key not verified: ${res.data?.error || 'Unknown'}`);
        }
    } catch (err) {
        console.warn(`⚠️ Notice: Could not verify Bot Key against backend:`, err.message);
    }
}

let isLoggingOutRemotely = false;

async function checkRemoteLogout() {
    if (isLoggingOutRemotely) return;
    try {
        const queryCollege = TARGET_COLLEGE || '';
        const url = `${BACKEND_BASE}/api/college-config/bot-status?college=${encodeURIComponent(queryCollege)}`;
        const res = await axios.get(url, { timeout: 5000 });
        const data = res.data;
        if (data && data.logoutRequested === true) {
            isLoggingOutRemotely = true;
            const targetCol = data.college || TARGET_COLLEGE || 'Campus';
            console.log(`\n=============================================================`);
            console.log(`🚪 [REMOTE LOGOUT RECEIVED] Main Admin requested Bot Logout for: *${targetCol}*!`);
            console.log(`=============================================================`);

            // 1. Acknowledge logout to backend immediately so the flag resets
            try {
                await axios.post(`${BACKEND_BASE}/api/college-config/bot-ack-logout?college=${encodeURIComponent(targetCol)}`, null, { timeout: 5000 });
                console.log(`✅ [ACKNOWLEDGED] Logout command acknowledged to backend.`);
            } catch (ackErr) {
                console.warn(`⚠️ Could not send ack-logout:`, ackErr.message);
            }

            // 2. Disconnect and logout Baileys socket
            if (sock) {
                try {
                    console.log(`🔌 Unlinking WhatsApp session...`);
                    await sock.logout();
                } catch (e) {
                    try { sock.end(); } catch (endErr) {}
                }
                sock = null;
            }

            // 3. Purge auth directory credentials completely
            const authDirToClean = getAuthDir();
            if (fs.existsSync(authDirToClean)) {
                try {
                    fs.rmSync(authDirToClean, { recursive: true, force: true });
                    console.log(`🧹 WhatsApp credentials deleted: ${authDirToClean}`);
                } catch (rmErr) {
                    console.warn(`⚠️ Warning: Could not purge auth dir:`, rmErr.message);
                }
            }

            const defaultAuth = path.join(__dirname, '.baileys_auth');
            if (fs.existsSync(defaultAuth) && defaultAuth !== authDirToClean) {
                try { fs.rmSync(defaultAuth, { recursive: true, force: true }); } catch (e) {}
            }

            // 4. Update qr_display.html
            try {
                const unlinkedHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>WhatsApp Bot Logged Out</title>
<style>
  body { background: #0f172a; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
  .card { background: white; padding: 32px; border-radius: 24px; text-align: center; color: #0f172a; box-shadow: 0 25px 50px rgba(0,0,0,0.5); }
  h1 { color: #dc2626; margin: 0 0 8px 0; font-size: 22px; }
  p { color: #64748b; margin: 0 0 20px 0; font-size: 14px; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1>🚪 WhatsApp Bot Unlinked</h1>
    <p>Logged out by Main Admin. Generating a fresh QR code now...</p>
  </div>
</body>
</html>`;
                fs.writeFileSync(path.join(__dirname, '..', 'qr_display.html'), unlinkedHtml);
            } catch (e) {}

            console.log(`🔄 [QR RE-GENERATION] Generating a fresh QR code now...\n`);
            setTimeout(async () => {
                isLoggingOutRemotely = false;
                await startBot();
            }, 2500);
        }
    } catch (err) {
        // Silently ignore network blips
    }
}

// Background polling for Main Admin remote logout signals every 5 seconds
setInterval(checkRemoteLogout, 5000);

async function startBot() {
    if (!isBotInitialized) {
        await verifyBotApiKey();
        isBotInitialized = true;
    }

    AUTH_DIR = getAuthDir();
    PREFS_FILE = getPrefsFile();

    if (IS_DEDICATED_BOT) {
        console.log(`🏫 [DEDICATED BOT MODE] Active for Campus: *${TARGET_COLLEGE}*`);
    } else {
        console.log('🌐 [UNIFIED BOT MODE] Active in Multi-Campus Discovery Mode...');
    }

    if (sock) {
        try { sock.ev.removeAllListeners(); } catch (e) {}
        try { sock.end(); } catch (e) {}
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        browser: ['Cloud Print Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    let isStartingOrderMonitoring = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 SCAN THIS QR CODE WITH YOUR WHATSAPP PHONE (Linked Devices):\n');
            qrcode.generate(qr, { small: true });

            try {
                const dataUrl = await QRCodeImage.toDataURL(qr, { width: 320, margin: 2 });
                const campusTitle = IS_DEDICATED_BOT ? `${TARGET_COLLEGE} WhatsApp Bot QR Code` : 'WhatsApp Bot QR Code';
                const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>${campusTitle}</title>
<style>
  body { background: #0f172a; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
  .card { background: white; padding: 32px; border-radius: 24px; text-align: center; color: #0f172a; box-shadow: 0 25px 50px rgba(0,0,0,0.5); }
  img { border-radius: 12px; border: 2px solid #e2e8f0; width: 280px; height: 280px; }
  h1 { color: #0284c7; margin: 0 0 8px 0; font-size: 22px; }
  p { color: #64748b; margin: 0 0 20px 0; font-size: 14px; font-weight: 600; }
  .badge { display: inline-block; padding: 4px 10px; background: #e0f2fe; color: #0369a1; border-radius: 9999px; font-size: 12px; font-weight: 700; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${IS_DEDICATED_BOT ? `🏫 Dedicated: ${TARGET_COLLEGE}` : '🌐 Unified Multi-Campus Bot'}</div>
    <h1>📱 Scan with WhatsApp</h1>
    <p>WhatsApp &gt; Linked Devices &gt; Link a Device</p>
    <img src="${dataUrl}" alt="QR Code" />
  </div>
</body>
</html>`;
                fs.writeFileSync(path.join(__dirname, '..', 'qr_display.html'), html);
            } catch (err) {}
        }

        if (connection === 'open') {
            console.log('✅ Baileys WhatsApp Bot is connected and ready to receive messages!');
            startOrderMonitoring();
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isReplaced = statusCode === 440 || statusCode === DisconnectReason.connectionReplaced;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            if (sock) {
                try { sock.ev.removeAllListeners(); } catch (e) {}
                try { sock.end(); } catch (e) {}
                sock = null;
            }

            if (isLoggedOut) {
                console.log('❌ Device was unlinked / logged out. Purging session credentials...');
                const authDirToClean = getAuthDir();
                if (fs.existsSync(authDirToClean)) {
                    try { fs.rmSync(authDirToClean, { recursive: true, force: true }); } catch (e) {}
                }
                console.log('🔄 Restarting bot to generate a fresh QR code in 3s...');
                setTimeout(startBot, 3000);
                return;
            }

            if (isReplaced) {
                console.log('⚠️ Session connected from another terminal/process (status 440). Waiting 15s to avoid collision...');
                setTimeout(startBot, 15000);
                return;
            }

            console.log(`Connection closed (status ${statusCode || 'unknown'}). Reconnecting in 5s...`);
            setTimeout(startBot, 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            try {
                await handleIncomingMessage(msg);
            } catch (err) {
                console.error("Error processing message:", err.message);
            }
        }
    });
}

function extractPhoneNumber(msg, jid) {
    if (!jid) return 'Unknown';

    // 1. If remoteJid ends with @s.whatsapp.net (standard phone JID)
    if (jid.endsWith('@s.whatsapp.net')) {
        const clean = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (clean.length >= 10 && clean.length <= 13 && !clean.startsWith('1655')) {
            return clean.length === 12 && clean.startsWith('91') ? clean.substring(2) : clean;
        }
    }

    // 2. Check participant / participantPn in msg.key
    const pJid = msg?.key?.participant || msg?.participant || msg?.key?.participantPn;
    if (pJid && typeof pJid === 'string' && pJid.endsWith('@s.whatsapp.net')) {
        const clean = pJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (clean.length >= 10 && clean.length <= 13 && !clean.startsWith('1655')) {
            return clean.length === 12 && clean.startsWith('91') ? clean.substring(2) : clean;
        }
    }

    // 3. Check remoteJidAlt / sender
    const altJid = msg?.key?.remoteJidAlt || msg?.key?.sender || msg?.sender;
    if (altJid && typeof altJid === 'string' && altJid.endsWith('@s.whatsapp.net')) {
        const clean = altJid.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (clean.length >= 10 && clean.length <= 13 && !clean.startsWith('1655')) {
            return clean.length === 12 && clean.startsWith('91') ? clean.substring(2) : clean;
        }
    }

    // 4. Fallback from raw JID
    const clean = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    return clean.length >= 10 ? clean : 'Unknown';
}

async function handleIncomingMessage(msg) {
    try {
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

        // Rate limit cooldown check: Do not reply to this contact for 10 minutes if placed in cooldown
        if (isContactInCooldown(jid)) {
            const tracker = spamTracker.get(jid);
            const remainingSec = Math.max(1, Math.ceil((tracker.cooldownUntil - Date.now()) / 1000));
            const remainingMin = Math.ceil(remainingSec / 60);
            console.log(`⏳ [COOLDOWN ACTIVE] Dropping incoming message from ${jid} (${remainingMin}m / ${remainingSec}s remaining).`);
            return;
        }

        const senderPhone = extractPhoneNumber(msg, jid);
        const senderName = msg.pushName || 'Student';
        const messageContent = msg.message;
        const textMessage = messageContent?.conversation || 
                            messageContent?.extendedTextMessage?.text || 
                            messageContent?.documentMessage?.caption || 
                            messageContent?.imageMessage?.caption || '';
        const rawText = textMessage.trim();
        const textLower = rawText.toLowerCase();

        console.log(`💬 Message received from ${senderPhone} (${senderName}): "${rawText}"`);

        const sessions = loadSessions();
        const sessionKey = jid; // Primary key by JID to ensure exact device mapping
        if (!sessions[sessionKey]) {
            sessions[sessionKey] = {
                phoneNumber: (senderPhone.length === 10 || (senderPhone.length === 12 && senderPhone.startsWith('91'))) ? senderPhone : null,
                realPhoneNumber: (senderPhone.length === 10 || (senderPhone.length === 12 && senderPhone.startsWith('91'))) ? senderPhone : null,
                name: senderName,
                jid: jid,
                college: null,
                blockLocation: null,
                step: 'IDLE',
                pending: null
            };
        }
        const session = sessions[sessionKey];
        session.jid = jid;
        if (senderName && senderName !== 'Student') session.name = senderName;

        // Check if student sent their 10-digit phone number (e.g. 9494189664 or +91 9494189664)
        const phoneMatch = rawText.match(/^(?:\+?91[\s-]?)?([6-9]\d{9})$/);
        if (phoneMatch && (!session.pending || session.step === 'ASK_PHONE')) {
            const clean10 = phoneMatch[1];
            session.realPhoneNumber = clean10;
            session.phoneNumber = clean10;
            session.step = session.pending ? 'SELECT_OPTIONS' : 'IDLE';
            resetInvalidCount(jid);
            saveSessions(sessions);

            await sock.sendMessage(jid, { 
                text: `✅ *Mobile Number Verified & Linked*: *+91 ${clean10}*\n\nYour student print wallet and order history are now registered under *${clean10}*!` 
            });

            if (session.pending) {
                // Return to draft confirmation
                await showOrderSummaryAndOptions(sock, jid, session);
            }
            return;
        }

        const effectivePhone = session.realPhoneNumber || (senderPhone.length === 10 ? senderPhone : (senderPhone.length === 12 && senderPhone.startsWith('91') ? senderPhone.substring(2) : senderPhone));

        const collegesMap = await getCollegesAndBlocks();
        const collegeList = Object.keys(collegesMap);

        // ==========================================
        // Admin Test / Low Paper Alert Command Trigger
        // ==========================================
        if (textLower === '!alert' || textLower === '!lowpaper' || textLower === '!paper' || textLower === '!test_alert' || textLower === 'test alert' || textLower === '!test') {
            const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            const testAlertMsg = `🚨 *CLOUD PRINT HARDWARE ALERT*\n` +
                                 `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                 `📍 *Location*: *C Block (KLU)*\n` +
                                 `🖨️ *Printer*: *Kiosk Color LaserJet Pro*\n` +
                                 `⚠️ *Status*: *LOW_PAPER*\n` +
                                 `📝 *Details*: ⚠️ Low paper warning: Only 12 sheets remaining at C Block. Refill soon.\n` +
                                 `⏱️ *Time*: *${timestamp}*\n` +
                                 `━━━━━━━━━━━━━━━━━━━━━━\n` +
                                 `👉 *Action required*: Please inspect kiosk and refill paper tray!`;

            await sock.sendMessage(jid, { text: testAlertMsg });
            if (jid !== '919494189664@s.whatsapp.net') {
                await sock.sendMessage('919494189664@s.whatsapp.net', { text: testAlertMsg }).catch(() => {});
            }
            return;
        }

        // ==========================================
        // Handle Post-Print Receipt Request (Replies to "Would you like a receipt?")
        // ==========================================
        if (session.step === 'ASK_RECEIPT' || textLower === 'receipt' || textLower === '/receipt' || textLower === 'invoice' || textLower === '/invoice') {
            const isAffirmative = (
                textLower === '1' || 
                textLower === 'yes' || 
                textLower === 'send receipt' || 
                textLower === 'receipt' || 
                textLower === '/receipt' ||
                textLower === 'invoice' || 
                textLower === '/invoice' ||
                textLower === 'bill' ||
                textLower.includes('receipt')
            );
            const isNegative = (
                textLower === '2' || 
                textLower === 'no' || 
                textLower === 'no thank you' || 
                textLower === 'no thanks' || 
                textLower === 'done' || 
                textLower === 'skip'
            );

            if (session.step === 'ASK_RECEIPT' && isNegative) {
                resetInvalidCount(jid);
                await sock.sendMessage(jid, { text: "🥰 *Thank you for using Cloud Print!* Have a wonderful day! 🖨️✨" });
                session.step = 'IDLE';
                session.lastOrderId = null;
                session.lastOtp = null;
                session.otpReleased = true;
                session.completedOrderData = null;
                session.notifiedCompletion = false;
                session.paymentNotified = false;
                session.pending = null;
                session.receiptAskTimestamp = null;
                saveSessions(sessions);
                return;
            }

            if (isAffirmative) {
                resetInvalidCount(jid);
                let orderData = session.completedOrderData || (session.lastOrderId ? {
                    orderId: session.lastOrderId,
                    fileName: 'Document.pdf',
                    totalPages: session.lastPages || 1,
                    printType: 'BW',
                    doubleSided: false,
                    copies: 1,
                    price: session.lastPrice || 0,
                    originalPrice: session.lastPrice || 0,
                    discountAmount: session.lastDiscountAmount || 0,
                    blockLocation: session.blockLocation || 'Campus Kiosk',
                    transactionId: 'WALLET_PAYMENT',
                    paymentMethod: 'WhatsApp Cloud Print',
                    paidAt: Date.now()
                } : null);

                // Fallback: If not in memory, query latest completed order directly from backend database!
                if (!orderData && effectivePhone) {
                    try {
                        const orderRes = await axios.get(`${BACKEND_BASE}/api/bot/latest-order?phoneNumber=${effectivePhone}`, { timeout: 6000 });
                        if (orderRes.data && orderRes.data.orderId) {
                            const dbOrder = orderRes.data;
                            orderData = {
                                orderId: dbOrder.orderId,
                                fileName: dbOrder.fileName || 'Document.pdf',
                                totalPages: dbOrder.totalPages || 1,
                                printType: dbOrder.printType || 'BW',
                                doubleSided: Boolean(dbOrder.doubleSided),
                                copies: dbOrder.copies || 1,
                                price: dbOrder.price || 0,
                                originalPrice: dbOrder.originalPrice || dbOrder.price || 0,
                                discountAmount: dbOrder.discountAmount || 0,
                                blockLocation: dbOrder.blockLocation || session.blockLocation || 'Campus Kiosk',
                                transactionId: dbOrder.transactionId || 'WALLET_PAYMENT',
                                paymentMethod: dbOrder.orderChannel || 'WhatsApp Cloud Print',
                                paidAt: dbOrder.paymentTime || Date.now()
                            };
                            console.log(`🧾 Retrieved latest order from database for receipt: ${orderData.orderId}`);
                        }
                    } catch (fetchErr) {
                        console.warn(`Could not fetch latest order from DB for receipt:`, fetchErr.message);
                    }
                }

                if (orderData) {
                    await sock.sendMessage(jid, { text: "📄 *Generating your Official PDF Payment Receipt...* Please wait a moment! ⏳" });
                    try {
                        const receiptPdfBuffer = await createReceiptPdf(orderData);
                        await sock.sendMessage(jid, {
                            document: receiptPdfBuffer,
                            mimetype: 'application/pdf',
                            fileName: `CloudPrint_Receipt_${orderData.orderId || 'Order'}.pdf`,
                            caption: `🧾 *Official Payment Receipt for Order ${orderData.orderId || ''}*\n\nThank you for choosing Cloud Print Self-Service Kiosks! 🖨️✨\n\n📄 *You can now send a new file anytime to start a fresh print!*`
                        });
                        session.step = 'IDLE';
                        session.lastOrderId = null;
                        session.lastOtp = null;
                        session.otpReleased = true;
                        session.completedOrderData = null;
                        session.notifiedCompletion = false;
                        session.paymentNotified = false;
                        session.pending = null;
                        session.receiptAskTimestamp = null;
                        saveSessions(sessions);
                        return;
                    } catch (pdfErr) {
                        console.error("Error generating receipt PDF:", pdfErr);
                        await sock.sendMessage(jid, { text: "⚠️ Could not generate PDF receipt. Please download from your web dashboard." });
                        session.step = 'IDLE';
                        session.lastOrderId = null;
                        session.lastOtp = null;
                        session.otpReleased = true;
                        session.completedOrderData = null;
                        session.notifiedCompletion = false;
                        session.paymentNotified = false;
                        session.pending = null;
                        session.receiptAskTimestamp = null;
                        saveSessions(sessions);
                        return;
                    }
                } else {
                    await sock.sendMessage(jid, { text: "⚠️ No recent completed order found to generate a receipt. Please print a document first!" });
                    session.step = 'IDLE';
                    session.lastOrderId = null;
                    session.lastOtp = null;
                    session.otpReleased = true;
                    session.completedOrderData = null;
                    session.notifiedCompletion = false;
                    session.paymentNotified = false;
                    session.pending = null;
                    session.receiptAskTimestamp = null;
                    saveSessions(sessions);
                    return;
                }
            }
        }

        // Cancel order command
        if (textLower === 'cancel' || textLower === 'cancel order' || textLower === '/cancel') {
            if (session.lastOrderId) {
                const targetId = session.lastOrderId;
                let wasPaid = false;
                let actualPrice = session.lastPrice || 0.0;

                try {
                    const chk = await axios.get(`${BACKEND_BASE}/api/pdf/details?orderId=${targetId}`, { timeout: 4000 });
                    if (chk.data) {
                        const pStatus = (chk.data.paymentStatus || '').toUpperCase();
                        if (pStatus === 'PAID' || chk.data.paidViaWallet) {
                            wasPaid = true;
                        }
                        if (chk.data.price) actualPrice = Number(chk.data.price);
                    }
                } catch (e) {
                    wasPaid = Boolean(session.paidTimestamp && session.paymentNotified);
                }

                // Call backend cancel if endpoint is available
                try {
                    await axios.post(`${BACKEND_BASE}/api/pdf/cancelOrder?orderId=${targetId}`, null, { timeout: 4000 });
                } catch (e) {}

                session.lastOrderId = null;
                session.lastOtp = null;
                session.paymentNotified = false;
                session.paidTimestamp = null;
                session.pending = null;
                session.step = 'IDLE';
                saveSessions(sessions);

                if (wasPaid && actualPrice > 0) {
                    const refundVal = actualPrice;
                    const couponCode = await generateRefundCoupon(refundVal);
                    const refundMsg = `❌ *Order ${targetId} Cancelled!*\n\n` +
                                      `🎟️ *PRINT REFUND COUPON GENERATED*:\n` +
                                      `-----------------------------------------\n` +
                                      `💰 *Refund Value*: *₹${refundVal.toFixed(2)}*\n` +
                                      `🏷️ *Coupon Code*: *${couponCode}*\n` +
                                      `⏰ *Validity*: *7 Days* (Single Use Only)\n` +
                                      `-----------------------------------------\n` +
                                      `💡 *How to use this coupon:*\n` +
                                      `• 💬 *In WhatsApp*: Reply *"COUPON ${couponCode}"* right here to add ₹${refundVal.toFixed(2)} directly to your wallet balance!\n` +
                                      `• 🌐 *At Web Checkout*: Or apply code *${couponCode}* at checkout to reduce your print total!`;

                    await sock.sendMessage(jid, { text: refundMsg });
                } else {
                    await sock.sendMessage(jid, { text: `❌ *Unpaid Order ${targetId} Cancelled!*\n\nNo payment was made, so no charges were applied. You can attach and send a new document to print anytime.` });
                }
                return;
            } else if (session.pending) {
                session.pending = null;
                session.step = 'IDLE';
                saveSessions(sessions);
                await sock.sendMessage(jid, { text: `❌ *Order draft cancelled!* You can attach a new document to print anytime.` });
                return;
            }
        }

        // 1. Check for Wallet / Balance Inquiry e.g. "balance", "wallet", "my balance", "bal", "check wallet"
        const isBalanceCheck = (
            textLower === 'balance' ||
            textLower === 'wallet' ||
            textLower === 'my balance' ||
            textLower === 'my wallet' ||
            textLower === 'check balance' ||
            textLower === 'check wallet' ||
            textLower === 'view balance' ||
            textLower === 'view wallet' ||
            textLower === 'show balance' ||
            textLower === 'show wallet' ||
            textLower === 'bal' ||
            textLower === 'money' ||
            textLower === '/balance' ||
            textLower === '/wallet' ||
            textLower === '/bal'
        );

        if (isBalanceCheck) {
            const phoneToQuery = session.realPhoneNumber || session.phoneNumber || senderPhone;
            try {
                const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${encodeURIComponent(phoneToQuery)}`, { timeout: 5000 });
                const userBal = balRes.data?.balance || 0.0;
                const balMsg = `💳 *Cloud Print Student Digital Wallet* 🖨️\n` +
                               `-----------------------------------\n` +
                               `📱 *Registered Phone*: *${phoneToQuery}*\n` +
                               `💰 *Available Wallet Balance*: *₹${userBal.toFixed(2)}*\n` +
                               `-----------------------------------\n` +
                               `⚡ *Instant 1-Tap Printing*: Your wallet balance is automatically used for zero-fee, instant print releases at kiosks!\n\n` +
                               `🎟️ *Have a Coupon or Voucher Code?*\n` +
                               `• 💬 *In WhatsApp*: Send *"COUPON <Code>"* (e.g. *COUPON 123456*) to credit funds directly into your wallet!\n` +
                               `• 🌐 *At Web Checkout*: Or apply your code on the checkout payment screen to reduce your print price!`;
                await sock.sendMessage(jid, { text: balMsg });
                return;
            } catch (bErr) {
                await sock.sendMessage(jid, { text: `💳 *Wallet Balance*: ₹0.00` });
                return;
            }
        }

        // 2. Check for Coupon / Voucher Redemption
        // Matches: "coupon 123456", "cupon00000", "cupon 00000", "voucher 50", "voture 50", "redeem 123456", "BONUS1208", "SAVE1302", "123456", "00000"
        let couponCodeFound = null;

        const couponPrefixMatch = rawText.match(/^(?:coupon|cupon|copon|voucher|voture|redeem|claim|promo|code|apply|use)\s*[:=-]?\s*([a-zA-Z0-9_-]+)$/i);
        if (couponPrefixMatch) {
            couponCodeFound = couponPrefixMatch[1];
        } else if (/^(?:coupon|cupon|copon|voucher|voture|redeem|claim|promo)[a-zA-Z0-9_-]+$/i.test(rawText)) {
            couponCodeFound = rawText; // e.g. cupon00000, coupon00000, voucher123
        } else if (/^[A-Za-z]{2,6}\d{2,6}$/.test(rawText)) {
            // e.g. BONUS1208, SAVE1302, CP50, CP1234
            couponCodeFound = rawText;
        } else if (/^\d{5,8}$/.test(rawText)) {
            // 5-8 digit numeric code (e.g. 00000, 123456, 880996) - 4-digit is reserved for Kiosk OTP
            couponCodeFound = rawText;
        }

        if (couponCodeFound && session.step !== 'CONFIRM_ORDER' && session.step !== 'SELECT_BLOCK') {
            const cleanCode = couponCodeFound.trim().toUpperCase();
            const phoneToRedeem = session.realPhoneNumber || session.phoneNumber || senderPhone;
            try {
                const redeemRes = await axios.post(
                    `${BACKEND_BASE}/api/bot/redeem-coupon?phoneNumber=${encodeURIComponent(phoneToRedeem)}&couponCode=${encodeURIComponent(cleanCode)}`,
                    null,
                    { timeout: 8000 }
                );
                const rData = redeemRes.data || {};
                if (rData.success) {
                    const couponSuccessMsg = `🎉 *Voucher / Coupon Applied Successfully!* 🎟️\n` +
                                             `-----------------------------------\n` +
                                             `💰 *Cash Credited*: *₹${(rData.creditedAmount || 0.0).toFixed(2)}*\n` +
                                             `💳 *Updated Wallet Balance*: *₹${(rData.newBalance || 0.0).toFixed(2)}*\n` +
                                             `-----------------------------------\n` +
                                             `💡 You can now use your wallet balance for instant 1-click print orders anytime!`;
                    await sock.sendMessage(jid, { text: couponSuccessMsg });
                    return;
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Coupon Code Cannot Be Used* (*${cleanCode}*)\n-----------------------------------\n❌ ${rData.message || 'Invalid, expired, or already used code.'}` });
                    return;
                }
            } catch (cErr) {
                console.error("Coupon redemption error:", cErr.message);
                const errMsg = cErr.response?.data?.message || cErr.response?.data || "Could not redeem coupon right now. Please check if the code was already used or expired.";
                await sock.sendMessage(jid, { text: `⚠️ *Coupon Redemption Failed*: ${errMsg}` });
                return;
            }
        }

        // Check if user is entering 4-Digit Release OTP (Processed FIRST before any menus or locks)
        const trimmedOtp = (rawText || '').trim();
        if (/^\d{4}$/.test(trimmedOtp)) {
            let activeOrderToRelease = session.lastOrderId;

            // If session doesn't have the order ID, query active orders to find the student's order matching phone or OTP
            if (!activeOrderToRelease) {
                try {
                    const ordersRes = await axios.get(`${BACKEND_BASE}/api/pdf/orders`, { params: { t: Date.now() }, timeout: 5000 });
                    const allOrders = ordersRes.data || [];
                    const found = allOrders.find(o => 
                        (o.status === 'PENDING_SCAN' || o.status === 'CANCEL_WINDOW') && 
                        (o.customerName?.includes(senderPhone) || o.userId == senderPhone || o.otpCode === trimmedOtp)
                    );
                    if (found) {
                        activeOrderToRelease = found.orderId;
                        session.lastOrderId = found.orderId;
                        if (found.blockLocation) session.blockLocation = found.blockLocation;
                    }
                } catch (e) {
                    console.error("Error searching orders for OTP:", e.message);
                }
            }

            if (activeOrderToRelease) {
                try {
                    const releaseRes = await axios.post(`${BACKEND_BASE}/api/pdf/releasePrint?orderId=${activeOrderToRelease}&otp=${trimmedOtp}`, null, { timeout: 10000 });
                    if (releaseRes.data) {
                        await sock.sendMessage(jid, {
                            text: `✅ *OTP Verified!* 🎉\n\n🖨️ *Print Job Spooling...* Your document is being printed right now at *${session.blockLocation || 'Kiosk'}* printer tray.\n\nReceipt & pickup notification will be sent upon completion!`
                        });
                        session.otpReleased = true;
                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        return;
                    }
                } catch (otpErr) {
                    const errMsg = otpErr.response?.data?.message || otpErr.response?.data || '';
                    console.error("OTP Verification Error:", errMsg || otpErr.message);
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Incorrect OTP ("${trimmedOtp}")!*\n\nPlease look at the *${session.blockLocation || 'Campus Kiosk'} TV Display Screen* to check your 4-digit Release OTP, and reply with the correct code here in WhatsApp.`
                    });
                    return;
                }
            } else {
                // If no pending scan order found in session, check if there are ANY pending scan orders matching this OTP
                try {
                    const ordersRes = await axios.get(`${BACKEND_BASE}/api/pdf/orders`, { params: { t: Date.now() }, timeout: 5000 });
                    const allOrders = ordersRes.data || [];
                    const matchingOtpOrder = allOrders.find(o => 
                        (o.status === 'PENDING_SCAN' || o.status === 'CANCEL_WINDOW') && 
                        o.otpCode === trimmedOtp
                    );
                    if (matchingOtpOrder) {
                        const releaseRes = await axios.post(`${BACKEND_BASE}/api/pdf/releasePrint?orderId=${matchingOtpOrder.orderId}&otp=${trimmedOtp}`, null, { timeout: 10000 });
                        if (releaseRes.data) {
                            session.lastOrderId = matchingOtpOrder.orderId;
                            session.blockLocation = matchingOtpOrder.blockLocation || session.blockLocation;
                            session.otpReleased = true;
                            session.pending = null;
                            session.step = 'IDLE';
                            saveSessions(sessions);

                            await sock.sendMessage(jid, {
                                text: `✅ *OTP Verified for ${matchingOtpOrder.orderId}!* 🎉\n\n🖨️ *Print Job Spooling...* Your document is being printed right now at *${matchingOtpOrder.blockLocation || 'Kiosk'}* printer tray.\n\nReceipt & pickup notification will be sent upon completion!`
                            });
                            return;
                        }
                    }
                } catch (e) {
                    console.error("Fallback OTP lookup error:", e.message);
                }
            }
        }

        // Active Order Lock: Verify if user ACTUALLY has an unreleased active order in PENDING_SCAN or CANCEL_WINDOW
        if (session.lastOrderId && !session.otpReleased && !session.pending) {
            let isStillActive = false;
            try {
                const checkRes = await axios.get(`${BACKEND_BASE}/api/pdf/details?orderId=${session.lastOrderId}`, { timeout: 3500 });
                const oData = checkRes.data || {};
                if (oData.status === 'PENDING_SCAN' || oData.status === 'CANCEL_WINDOW' || (oData.paymentStatus === 'PAID' && oData.status !== 'COMPLETED' && oData.status !== 'PRINTING' && oData.status !== 'CANCELLED' && oData.status !== 'EXPIRED')) {
                    isStillActive = true;
                } else {
                    console.log(`ℹ️ Order ${session.lastOrderId} is status ${oData.status || 'UNKNOWN'}. Clearing active lock to allow new session.`);
                    session.lastOrderId = null;
                    session.lastOtp = null;
                    session.otpReleased = true;
                    session.completedOrderData = null;
                    session.notifiedCompletion = false;
                    session.paymentNotified = false;
                    session.step = 'IDLE';
                    saveSessions(sessions);
                }
            } catch (e) {
                if (e.response?.status === 404) {
                    console.log(`ℹ️ Order ${session.lastOrderId} not found (404). Clearing active lock.`);
                    session.lastOrderId = null;
                    session.lastOtp = null;
                    session.otpReleased = true;
                    session.step = 'IDLE';
                    saveSessions(sessions);
                }
            }

            if (isStillActive) {
                await sock.sendMessage(jid, {
                    text: `🔐 *Release Your Print (*${session.lastOrderId}*)!*\n\n` +
                          `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                          `📺 *Release OTP*: Look at the *Kiosk TV Display Screen* to find your 4-digit code!\n\n` +
                          `👉 *Please reply with your 4-digit OTP right here in WhatsApp* to release and print your pages directly!\n\n` +
                          `❌ *To cancel*: Reply *cancel* to cancel this order and refund.`
                });
                return;
            }
        }

        // Secret Admin command "CC" to reset / change college (hidden from regular user menus)
        if (textLower === 'cc' || textLower === '/cc' || textLower.includes('change college') || textLower.includes('change shop')) {
            if (IS_DEDICATED_BOT) {
                await sock.sendMessage(jid, {
                    text: `ℹ️ *This WhatsApp Bot is exclusively dedicated to ${TARGET_COLLEGE} Campus.*\n\n` +
                          `• If you need to switch your active printer inside *${TARGET_COLLEGE}*, reply *"CB"*\n` +
                          `• If you want to print at another university campus, please use the central *Unified Cloud Print Bot*.`
                });
                return;
            }

            session.college = null;
            session.blockLocation = null;
            session.pending = null;
            session.step = 'SELECT_COLLEGE';
            saveSessions(sessions);

            await sendSmartMenu(
                sock,
                jid,
                '🏫 Select College / Print Shop',
                'Please select your **College / Print Shop** below:',
                'Select College / Shop',
                collegeList.map(c => `🏫 ${c}`)
            );
            return;
        }

        // Secret Admin command "CB" to reset / change kiosk block (hidden from regular user menus)
        if (textLower === 'cb' || textLower === '/cb' || (!session.pending && session.step === 'IDLE' && (textLower === 'block' || textLower === '/block' || textLower.includes('change block') || textLower.includes('change kiosk')))) {
            if (session.college) {
                const blocks = collegesMap[session.college] || [];
                session.step = 'SELECT_BLOCK';
                saveSessions(sessions);

                await sendSmartMenu(
                    sock,
                    jid,
                    `📍 Available Kiosk Blocks in ${session.college}`,
                    'Please select your active kiosk block:',
                    'Cloud Print Kiosk',
                    blocks.map(b => `📍 ${b}`)
                );
                return;
            }
        }

        // 1. College Resolution & Auto-Lock
        if (IS_DEDICATED_BOT) {
            session.college = TARGET_COLLEGE;
        }

        // Auto-lock if only 1 college is configured in the entire system (e.g. KLU)
        if (!session.college && collegeList.length === 1) {
            session.college = collegeList[0];
            console.log(`🏫 [AUTO-LOCK] Only 1 college configured (${session.college}). Auto-locked for user.`);
        }

        // Check user preferences
        if (!session.college) {
            const prefs = sessionStore.userPrefs.get(jid) || {};
            if (prefs.college && (collegeList.length === 0 || collegeList.includes(prefs.college))) {
                session.college = prefs.college;
            }
        }

        // Check database via user-balance API
        if (!session.college && effectivePhone) {
            try {
                const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${effectivePhone}`, { timeout: 3000 });
                if (balRes.data && balRes.data.college && balRes.data.college !== 'UNIFIED') {
                    session.college = balRes.data.college;
                    console.log(`🏫 [AUTO-LOCK] Loaded registered college (${session.college}) from database for +91 ${effectivePhone}`);
                }
            } catch (e) {}
        }

        // If college is now resolved, save it permanently
        if (session.college) {
            sessionStore.userPrefs.set(jid, {
                college: session.college,
                blockLocation: session.blockLocation || null,
                realPhoneNumber: session.realPhoneNumber || effectivePhone
            });
            sessionStore.savePreferences();

            if (session.step === 'SELECT_COLLEGE') {
                session.step = session.blockLocation ? 'IDLE' : 'SELECT_BLOCK';
                saveSessions(sessions);
            }
            if (effectivePhone) {
                axios.post(`${BACKEND_BASE}/api/bot/set-user-college?phoneNumber=${effectivePhone}&college=${encodeURIComponent(session.college)}`, null, { timeout: 3000 }).catch(() => {});
            }
        }

        const isGreeting = /^(hi|hello|hilo|hey|heya|hola|good morning|good afternoon|good evening|namaste|sup|what's up|greetings|start|menu)\b/i.test(textLower);

        if (!session.college) {
            let chosenCollege = null;

            if (session.step === 'SELECT_COLLEGE' && !isGreeting) {
                const found = collegeList.find(c => textLower === c.toLowerCase() || rawText.toUpperCase() === c.toUpperCase() || textLower.includes(c.toLowerCase()));
                if (found) chosenCollege = found;
                else {
                    const num = parseInt(rawText, 10);
                    if (!isNaN(num) && num >= 1 && num <= collegeList.length) {
                        chosenCollege = collegeList[num - 1];
                    }
                }
            }

            if (chosenCollege && collegesMap[chosenCollege]) {
                session.college = chosenCollege;
                session.step = 'SELECT_BLOCK';
                resetInvalidCount(jid);
                saveSessions(sessions);

                // Persist college selection to DB
                if (effectivePhone) {
                    axios.post(`${BACKEND_BASE}/api/bot/set-user-college?phoneNumber=${effectivePhone}&college=${encodeURIComponent(chosenCollege)}`, null, { timeout: 3000 }).catch(() => {});
                }

                const blocks = collegesMap[chosenCollege] || [];
                if (blocks.length === 0) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *All Kiosks in ${chosenCollege} are Currently Offline!*\n\nOur system detected that all printers in *${chosenCollege}* are currently inactive or under maintenance.\n\nPlease try again shortly, or reply *"CC"* to choose another campus/print shop.`
                    });
                    return;
                }

                if (blocks.length === 1) {
                    session.blockLocation = blocks[0];
                    session.step = 'IDLE';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, {
                        text: `✅ *Campus Connected: ${chosenCollege}*\n📍 *Active Kiosk*: *${session.blockLocation}* (🟢 Online & Ready)\n\n📎 *To Print*: Simply attach and send any **PDF document or Image** right here!`
                    });
                    return;
                }

                await sendSmartMenu(
                    sock,
                    jid,
                    `✅ College Fixed: ${chosenCollege}`,
                    `Now select an **Active Online Kiosk** in *${chosenCollege}*:`,
                    'Select Online Kiosk',
                    blocks.map(b => `🟢 📍 ${b}`)
                );
                return;
            } else if (session.step === 'SELECT_COLLEGE' && !isGreeting) {
                await recordInvalidAttempt(sock, jid, async (warningSuffix) => {
                    await sendSmartMenu(
                        sock,
                        jid,
                        '⚠️ Invalid Choice',
                        `Please select a valid College / Print Shop number (1 to ${collegeList.length}) or reply with the college name below:${warningSuffix}`,
                        'Select College / Shop',
                        collegeList.map(c => `🏫 ${c}`)
                    );
                });
                return;
            } else {
                resetInvalidCount(jid);
                session.step = 'SELECT_COLLEGE';
                saveSessions(sessions);

                await sendSmartMenu(
                    sock,
                    jid,
                    '👋 Welcome to University Cloud Print Bot!',
                    'To get started, please select your **College / Print Shop** below:\n*(Note: Your selected College/Shop will be saved for future prints)*',
                    'Select College / Shop',
                    collegeList.map(c => `🏫 ${c}`)
                );
                return;
            }
        }

        // 2. Kiosk Block Selection
        const blocks = collegesMap[session.college] || [];

        // Auto-lock if single kiosk block in campus
        if (!session.blockLocation && blocks.length === 1) {
            session.blockLocation = blocks[0];
            session.step = 'IDLE';
            saveSessions(sessions);
            console.log(`📍 [AUTO-LOCK] Single kiosk block detected (${session.blockLocation}). Auto-locked for user.`);
        }

        if (session.step === 'SELECT_BLOCK' || !session.blockLocation) {
            if (blocks.length === 0) {
                const offlineNotice = IS_DEDICATED_BOT
                    ? `⚠️ *No Online Printers Found in ${session.college}!* \n\nAll printers in this campus are currently offline or under maintenance.\n\nPlease check back shortly, or reply *"CB"* to refresh.`
                    : `⚠️ *No Online Printers Found in ${session.college || 'Selected Campus'}!*\n\nAll printers in this campus are currently offline or under maintenance.\n\nReply *"CC"* to switch college/shop or check back soon!`;

                await sock.sendMessage(jid, { text: offlineNotice });
                return;
            }

            if (blocks.length === 1) {
                session.blockLocation = blocks[0];
                session.step = 'IDLE';
                saveSessions(sessions);
            } else {
                let chosenBlock = null;

                if (!isGreeting) {
                    const found = blocks.find(b => textLower === b.toLowerCase() || rawText.toUpperCase() === b.toUpperCase() || textLower.includes(b.toLowerCase()));
                    if (found) chosenBlock = found;
                    else {
                        const num = parseInt(rawText, 10);
                        if (!isNaN(num) && num >= 1 && num <= blocks.length) {
                            chosenBlock = blocks[num - 1];
                        }
                    }
                }

                if (chosenBlock && blocks.includes(chosenBlock)) {
                    // Real-time live check before confirming block
                    const status = await checkKioskPrinterStatus(chosenBlock, 'BW');
                    if (!status.available) {
                        await sock.sendMessage(jid, {
                            text: `⚠️ *Kiosk Offline Alert*:\n${status.message}\n\nPlease choose an active online kiosk block from below:`
                        });
                        await sendSmartMenu(
                            sock,
                            jid,
                            `🟢 Available Online Kiosks (${session.college})`,
                            'Please select an active, operational kiosk below:',
                            'Select Online Kiosk',
                            blocks.map(b => `🟢 📍 ${b}`)
                        );
                        return;
                    }

                    resetInvalidCount(jid);
                    session.blockLocation = chosenBlock;
                    session.step = 'IDLE';
                    saveSessions(sessions);

                    await sendSmartMenu(
                        sock,
                        jid,
                        `✅ Verified Online Kiosk: ${chosenBlock}`,
                        `Campus: *${session.college}*\nPrinter Status: 🟢 **ONLINE & READY**\n\n🖨️ Simply attach and send your **PDF file or Image** to start your print order!`,
                        'Ready to Print'
                    );
                    return;
                } else if (session.step === 'SELECT_BLOCK' && !isGreeting) {
                    await recordInvalidAttempt(sock, jid, async (warningSuffix) => {
                        await sendSmartMenu(
                            sock,
                            jid,
                            `⚠️ Invalid Choice (${session.college})`,
                            `Please select a valid online kiosk number (1 to ${blocks.length}) below:${warningSuffix}`,
                            'Select Kiosk Block',
                            blocks.map(b => `🟢 📍 ${b}`)
                        );
                    });
                    return;
                } else {
                    resetInvalidCount(jid);
                    session.step = 'SELECT_BLOCK';
                    saveSessions(sessions);

                    const menuTitle = IS_DEDICATED_BOT
                        ? `👋 Welcome to ${TARGET_COLLEGE} Cloud Print!`
                        : `🟢 Online Kiosks (${session.college})`;

                    await sendSmartMenu(
                        sock,
                        jid,
                        menuTitle,
                        'Please select an active, online kiosk block below:',
                        'Select Kiosk Block',
                        blocks.map(b => `🟢 📍 ${b}`)
                    );
                    return;
                }
            }
        }

        // 3. Document / Media Attachment Received
        const docMsg = messageContent?.documentMessage || messageContent?.documentWithCaptionMessage?.message?.documentMessage;
        const imgMsg = messageContent?.imageMessage;

        if (docMsg || imgMsg) {
            resetInvalidCount(jid);
            // Verify user is not blocked
            try {
                const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 4000 });
                if (balRes.data && balRes.data.blocked) {
                    await sock.sendMessage(jid, {
                        text: "⛔ *Account Suspended Alert*:\n\nYour WhatsApp number has been suspended by the campus administrator. Printing and order creation services are blocked for this number.\n\nPlease contact campus admin to unblock your account."
                    });
                    return;
                }
            } catch (ignored) {}

            // Verify that the target kiosk printer is currently online before accepting document
            if (session.blockLocation) {
                const printerCheck = await checkKioskPrinterStatus(session.blockLocation, 'BW');
                if (!printerCheck.available) {
                    session.step = 'SELECT_BLOCK';
                    saveSessions(sessions);
                    const blocks = collegesMap[session.college] || [];
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Kiosk Offline Alert*:\nYour selected kiosk (*${session.blockLocation}*) is currently offline or under maintenance.\n\nPlease select an active online kiosk block below before uploading your document:`
                    });
                    if (blocks.length > 0) {
                        await sendSmartMenu(
                            sock,
                            jid,
                            `🟢 Online Kiosks (${session.college || 'Campus'})`,
                            'Please select an active online kiosk below:',
                            'Select Kiosk Block',
                            blocks.map(b => `🟢 📍 ${b}`)
                        );
                    }
                    return;
                }
            }

            // If user has an active pending order, verify if it's genuinely still active
            if (session.lastOrderId && !session.otpReleased) {
                let isStillActive = false;
                try {
                    const checkRes = await axios.get(`${BACKEND_BASE}/api/pdf/details?orderId=${session.lastOrderId}`, { timeout: 3500 });
                    const oData = checkRes.data || {};
                    if (oData.status === 'PENDING_SCAN' || oData.status === 'CANCEL_WINDOW' || (oData.paymentStatus === 'PAID' && oData.status !== 'COMPLETED' && oData.status !== 'PRINTING' && oData.status !== 'CANCELLED' && oData.status !== 'EXPIRED')) {
                        isStillActive = true;
                    } else {
                        console.log(`ℹ️ Previous order ${session.lastOrderId} is status ${oData.status || 'UNKNOWN'}. Clearing old order to process new document.`);
                        session.lastOrderId = null;
                        session.lastOtp = null;
                        session.otpReleased = true;
                        session.completedOrderData = null;
                        session.notifiedCompletion = false;
                        session.paymentNotified = false;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                    }
                } catch (e) {
                    if (e.response?.status === 404) {
                        session.lastOrderId = null;
                        session.otpReleased = true;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                    }
                }

                if (isStillActive) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *You already have an active order (*${session.lastOrderId}*)!*\n\n` +
                              `📺 Look at the *${session.blockLocation || 'Campus Kiosk'} TV Display Screen* for your 4-digit code and reply with it here to print.\n\n` +
                              `❌ Or reply *cancel* to cancel your previous order before sending a new file.`
                    });
                    return;
                }
            }

            let buffer;
            try {
                buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
            } catch (dlErr) {
                console.error("Baileys direct download error:", dlErr.message);
                await sock.sendMessage(jid, { text: "⚠️ Could not download file attachment. Please try resending." });
                return;
            }

            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(jid, { text: "⚠️ Empty document received. Please try sending again." });
                return;
            }

            const mimetype = docMsg?.mimetype || imgMsg?.mimetype || 'application/pdf';
            let filename = docMsg?.fileName || (imgMsg ? 'photo.jpg' : rawText);
            if (!filename || filename.trim().length === 0) {
                filename = imgMsg ? 'photo.jpg' : (mimetype.includes('pdf') ? 'document.pdf' : 'file');
            }
            const lowerName = (filename || '').toLowerCase();
            const isImage = Boolean(
                imgMsg ||
                (mimetype && mimetype.startsWith('image/')) ||
                lowerName.endsWith('.jpg') ||
                lowerName.endsWith('.jpeg') ||
                lowerName.endsWith('.png') ||
                lowerName.endsWith('.webp') ||
                lowerName.endsWith('.heic') ||
                lowerName.endsWith('.bmp')
            );

            const totalPages = (mimetype.includes('pdf') && !isImage) ? getPDFPageCount(buffer) : 1;

            const caption = (docMsg?.caption || imgMsg?.caption || rawText || '').trim();
            const copyMatch = caption.match(/\b(\d+)\s*(?:copies|copy|sets|set|nos|times|prints|print)\b/i);
            let initialCopies = 1;
            if (copyMatch) {
                const parsed = parseInt(copyMatch[1], 10);
                if (parsed >= 1) initialCopies = parsed;
            }

            // Store document buffer in in-memory bufferCache with TTL
            sessionStore.setBuffer(jid, buffer);

            session.pending = {
                filename,
                mimetype: isImage ? (mimetype.startsWith('image/') ? mimetype : 'image/jpeg') : mimetype,
                isImage,
                totalPages,
                layoutMode: '1-UP',
                selectedPages: 'ALL',
                doubleSided: false,
                printType: 'BW',
                copies: initialCopies
            };
            session.step = 'SELECT_PRINT_MODE';
            saveSessions(sessions);

            const colorCheck = await checkKioskPrinterStatus(session.blockLocation, 'COLOR');
            const isColorSupported = Boolean(colorCheck && colorCheck.available);
            session.pending.isColorSupported = isColorSupported;

            if (isImage) {
                const imgOptions = isColorSupported
                    ? ['📄 Single Sided B&W Print (₹2.00)', '🎨 Color Print (₹5.00)', '⚙️ Customize Copies & Settings']
                    : ['📄 Single Sided B&W Print (₹2.00)', '⚙️ Customize Copies & Settings'];
                await sendSmartMenu(
                    sock,
                    jid,
                    `🖼️ Photo Received: ${filename}`,
                    `📷 *Photo / Image (1 Page)*\n📍 Target Kiosk: *${session.blockLocation}* (${session.college})\n\nHow would you like to print this photo?`,
                    'Select Print Option',
                    imgOptions
                );
            } else {
                const docOptions = [
                    '📄 Single Sided B&W Print (₹2/pg)',
                    '📑 Double Sided B&W Print (₹1.50/pg)'
                ];
                if (totalPages >= 2) {
                    docOptions.push('📑 2 Slides/Page (50% Saver - ₹1/slide)');
                }
                if (totalPages >= 4) {
                    docOptions.push('📑 4 Slides/Page (75% Super Saver - ₹0.50/slide)');
                }
                if (isColorSupported) {
                    docOptions.push('🎨 Color Print (₹5/pg)');
                }
                docOptions.push('⚙️ Customize Section (Custom Pages, Copies, Layout)');

                await sendSmartMenu(
                    sock,
                    jid,
                    `📄 Document Received: ${filename}`,
                    `📊 Total Pages Detected: *${totalPages}*\n📍 Target Kiosk: *${session.blockLocation}* (${session.college})\n\nHow would you like to print?`,
                    'Select Print Mode',
                    docOptions
                );
            }
            return;
        }

        // 4. Interactive Step Handling for Pending Print
        if (session.pending) {

            if (session.step === 'SELECT_PRINT_MODE') {
                const printerCheck = await checkKioskPrinterStatus(session.blockLocation, 'BW');
                if (!printerCheck.available) {
                    session.pending = null;
                    session.step = 'SELECT_BLOCK';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Kiosk Offline Alert*:\nYour selected kiosk (*${session.blockLocation}*) is currently offline, unassigned, or under maintenance.\n\n🚫 *Orders cannot be placed for this block at this moment.*\n\nPlease choose an active online kiosk below to proceed with your print:`
                    });
                    const collegesMap = await getCollegesAndBlocks();
                    const blocks = collegesMap[session.college] || [];
                    if (blocks.length > 0) {
                        await sendSmartMenu(
                            sock,
                            jid,
                            `🟢 Available Online Kiosks (${session.college || 'Campus'})`,
                            'Please select an active online kiosk below:',
                            'Select Kiosk Block',
                            blocks.map(b => `🟢 📍 ${b}`)
                        );
                    }
                    return;
                }

                const isColorSupported = Boolean(session.pending.isColorSupported);

                // Option 1: Single Sided Black & White Print (All Pages)
                if (textLower.includes('single') || textLower === '1') {
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = false;
                    session.pending.printType = 'BW';
                    session.pending.copies = 1;

                    const pageCount = countPagesFromRange('ALL', session.pending.totalPages);
                    const rate = 2.0;
                    const estimatedTotal = pageCount * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = session.walletBalance || 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                            session.walletBalance = userBalance;
                            saveSessions(sessions);
                        }
                    } catch (e) {
                        console.error("user-balance fetch error in Single Sided B&W Print:", e.message);
                    }

                    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                        `📄 File: *${session.pending.filename}*\n` +
                        `📊 Pages: *${pageCount}* (Range: ALL)\n` +
                        `📑 Sides: *Single Sided*\n` +
                        `🎨 Mode: *Black & White (₹2/pg)*\n` +
                        `🔢 Copies: *1*\n` +
                        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n` +
                        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                    await sock.sendMessage(jid, { text: summaryText });
                    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                    return;
                }

                // Option 2: Double Sided (Duplex) Black & White Print (All Pages)
                if ((!session.pending.isImage && (textLower.includes('double') || textLower.includes('both') || textLower.includes('duplex') || textLower === '2')) ||
                    (session.pending.isImage && !isColorSupported && (textLower.includes('custom') || textLower === '2')) ||
                    (session.pending.isImage && isColorSupported && (textLower.includes('color') || textLower === '2'))) {
                    
                    if (session.pending.isImage && isColorSupported && (textLower.includes('color') || textLower === '2')) {
                        // Image Color Print
                        session.pending.selectedPages = 'ALL';
                        session.pending.doubleSided = false;
                        session.pending.printType = 'COLOR';
                        session.pending.copies = 1;
                        const estimatedTotal = 5.0;
                        session.pending.estimatedTotal = estimatedTotal;

                        let userBalance = session.walletBalance || 0.0;
                        try {
                            const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                            if (balRes.data && balRes.data.balance !== undefined) {
                                userBalance = parseFloat(balRes.data.balance) || 0.0;
                                session.walletBalance = userBalance;
                                saveSessions(sessions);
                            }
                        } catch (e) {}

                        const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                            `📄 File: *${session.pending.filename}*\n` +
                            `🖼️ Type: *Photo / Image (1 Page)*\n` +
                            `🎨 Mode: *Color (₹5.00)*\n` +
                            `🔢 Copies: *1*\n` +
                            `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                            `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n` +
                            `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                        await sock.sendMessage(jid, { text: summaryText });
                        await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                        return;
                    }

                    if (session.pending.isImage && !isColorSupported) {
                        // Image customize
                        session.pending.selectedPages = 'ALL';
                        session.pending.doubleSided = false;
                        session.step = 'ENTER_COPIES';
                        saveSessions(sessions);
                        await sock.sendMessage(jid, { text: `🔢 *Number of Copies*:\n\nReply with the number of copies you need (e.g. *1*, *2*, *5*, *10*):` });
                        return;
                    }

                    // Document Double Sided B&W Print
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = true;
                    session.pending.printType = 'BW';
                    session.pending.copies = 1;

                    const totalPgs = session.pending.totalPages || 1;
                    const sheets = Math.ceil(totalPgs / 2.0);
                    const rate = 1.50; // ₹1.50 per duplex page / sheet
                    const estimatedTotal = totalPgs === 1 ? 2.00 : sheets * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = session.walletBalance || 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                            session.walletBalance = userBalance;
                            saveSessions(sessions);
                        }
                    } catch (e) {
                        console.error("user-balance fetch error in Double Sided Print:", e.message);
                    }

                    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                        `📄 File: *${session.pending.filename}*\n` +
                        `📊 Pages: *${totalPgs}* (Range: ALL • ${sheets} Sheets)\n` +
                        `📑 Sides: *Double Sided (Duplex)*\n` +
                        `🎨 Mode: *Black & White (₹1.50/pg)*\n` +
                        `🔢 Copies: *1*\n` +
                        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n` +
                        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                    await sock.sendMessage(jid, { text: summaryText });
                    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                    return;
                }

                const totalPgs = session.pending.totalPages || 1;

                // Option: 2 Slides per Page (50% Saver)
                if (!session.pending.isImage && (textLower.includes('2 slide') || textLower.includes('2-up') || textLower.includes('2 in 1') || textLower.includes('2-in-1') || textLower.includes('50%') || (totalPgs >= 2 && textLower === '3'))) {
                    session.pending.layoutMode = '2-UP';
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = true;
                    session.pending.printType = 'BW';
                    session.pending.copies = 1;

                    const effectivePages = Math.ceil(totalPgs / 2.0);
                    const sheets = Math.ceil(effectivePages / 2.0);
                    const rate = 1.50; // ₹1.50 per duplex sheet
                    const estimatedTotal = effectivePages === 1 ? 2.00 : sheets * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = session.walletBalance || 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                            session.walletBalance = userBalance;
                            saveSessions(sessions);
                        }
                    } catch (e) {}

                    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                        `📄 File: *${session.pending.filename}*\n` +
                        `📊 Original Slides: *${totalPgs}* (Range: ALL)\n` +
                        `📑 Layout: *2 Slides per Page (📑 50% Saver)*\n` +
                        `🖨️ Physical Sheets: *${sheets} Sheet(s)* (${effectivePages} pages on paper)\n` +
                        `📑 Sides: *Double Sided (Duplex)*\n` +
                        `🎨 Mode: *Black & White*\n` +
                        `🔢 Copies: *1*\n` +
                        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}* *(50% Student Discount Applied)*\n` +
                        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                    await sock.sendMessage(jid, { text: summaryText });
                    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                    return;
                }

                // Option: 4 Slides per Page (75% Super Saver)
                if (!session.pending.isImage && (textLower.includes('4 slide') || textLower.includes('4-up') || textLower.includes('4 in 1') || textLower.includes('4-in-1') || textLower.includes('75%') || (totalPgs >= 4 && (textLower === '4' || textLower === '4up')))) {
                    session.pending.layoutMode = '4-UP';
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = true;
                    session.pending.printType = 'BW';
                    session.pending.copies = 1;

                    const effectivePages = Math.ceil(totalPgs / 4.0);
                    const sheets = Math.ceil(effectivePages / 2.0);
                    const rate = 1.50; // ₹1.50 per duplex sheet
                    const estimatedTotal = effectivePages === 1 ? 2.00 : sheets * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = session.walletBalance || 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                            session.walletBalance = userBalance;
                            saveSessions(sessions);
                        }
                    } catch (e) {}

                    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                        `📄 File: *${session.pending.filename}*\n` +
                        `📊 Original Slides: *${totalPgs}* (Range: ALL)\n` +
                        `📑 Layout: *4 Slides per Page (📑 75% Super Saver)*\n` +
                        `🖨️ Physical Sheets: *${sheets} Sheet(s)* (${effectivePages} pages on paper)\n` +
                        `📑 Sides: *Double Sided (Duplex)*\n` +
                        `🎨 Mode: *Black & White*\n` +
                        `🔢 Copies: *1*\n` +
                        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}* *(75% Student Discount Applied)*\n` +
                        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                    await sock.sendMessage(jid, { text: summaryText });
                    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                    return;
                }

                // Option: Color Print (when supported)
                if (isColorSupported && (textLower.includes('color') || textLower.includes('colour') || (totalPgs < 2 && textLower === '3') || (totalPgs >= 2 && totalPgs < 4 && textLower === '4') || (totalPgs >= 4 && textLower === '5'))) {
                    const colorCheck = await checkKioskPrinterStatus(session.blockLocation, 'COLOR');
                    if (!colorCheck.available) {
                        await sock.sendMessage(jid, {
                            text: `⚠️ *Color Printing Unavailable*:\n${colorCheck.message}\n\nPlease choose *1* for Single Sided B&W (₹2) or *2* for Double Sided B&W:`
                        });
                        return;
                    }
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = false;
                    session.pending.printType = 'COLOR';
                    session.pending.copies = 1;

                    const pageCount = countPagesFromRange('ALL', session.pending.totalPages);
                    const rate = 5.0;
                    const estimatedTotal = pageCount * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = session.walletBalance || 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 10000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                            session.walletBalance = userBalance;
                            saveSessions(sessions);
                        }
                    } catch (e) {}

                    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
                        `📄 File: *${session.pending.filename}*\n` +
                        `📊 Pages: *${pageCount}* (Range: ALL)\n` +
                        `📑 Sides: *Single Sided*\n` +
                        `🎨 Mode: *Color (₹5/pg)*\n` +
                        `🔢 Copies: *1*\n` +
                        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
                        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n` +
                        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

                    await sock.sendMessage(jid, { text: summaryText });
                    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
                    return;
                }

                // Customize Section
                const isCustomizeChoice = textLower.includes('custom') || textLower.includes('setting') ||
                                         (textLower === '6') ||
                                         (!isColorSupported && totalPgs >= 4 && textLower === '5') ||
                                         (!isColorSupported && totalPgs >= 2 && totalPgs < 4 && textLower === '4') ||
                                         (!isColorSupported && totalPgs < 2 && textLower === '3');

                if (isCustomizeChoice) {
                    if (session.pending.isImage) {
                        session.pending.selectedPages = 'ALL';
                        session.pending.doubleSided = false;
                        session.step = 'ENTER_COPIES';
                        saveSessions(sessions);
                        await sock.sendMessage(jid, { text: `🔢 *Number of Copies*:\n\nReply with any number of copies you need (e.g. *1*, *2*, *5*, *10*, *25*, etc.):` });
                        return;
                    }

                    if (session.pending.totalPages === 1) {
                        session.pending.selectedPages = 'ALL';
                        session.step = 'SELECT_SIDES';
                        saveSessions(sessions);

                        await sendSmartMenu(
                            sock,
                            jid,
                            '📑 Print Sides (Single vs Duplex)',
                            'Please choose print side orientation:',
                            'Select Print Sides',
                            ['📄 Single Sided (Rs. 2/page)', '📑 Both Sides / Duplex (Rs. 1.50/page)']
                        );
                        return;
                    } else {
                        session.step = 'SELECT_PAGE_OPTION';
                        saveSessions(sessions);

                        await sendSmartMenu(
                            sock,
                            jid,
                            '📄 Page Printing Range',
                            `Total Pages in PDF: *${session.pending.totalPages}*\n\nPlease select page printing option:`,
                            'Select Page Option',
                            [`📄 All Pages (1-${session.pending.totalPages})`, '🔢 Custom Page Range (Start to End)']
                        );
                        return;
                    }
                }

                // Invalid selection
                await recordInvalidAttempt(sock, jid, 
                    isColorSupported
                        ? `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with:\n• *1* for Single Sided B&W Print (₹2/pg)\n• *2* for Double Sided B&W Print (₹1.50/pg)\n• *3* for Color Print (₹5/pg)\n• *4* for Customize Section`
                        : `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with:\n• *1* for Single Sided B&W Print (₹2/pg)\n• *2* for Double Sided B&W Print (₹1.50/pg)\n• *3* for Customize Section`
                );
                return;
            }

            if (session.step === 'SELECT_PAGE_OPTION') {
                if (textLower.includes('all') || textLower === '1') {
                    resetInvalidCount(jid);
                    session.pending.selectedPages = 'ALL';
                    session.step = 'SELECT_SIDES';
                    saveSessions(sessions);

                    await sendSmartMenu(
                        sock,
                        jid,
                        '📑 Print Sides (Single vs Duplex)',
                        'Please choose print side orientation:',
                        'Select Print Sides',
                        ['📄 Single Sided (Rs. 2/page)', '📑 Both Sides / Duplex (Rs. 2/paper)']
                    );
                    return;
                } else if (textLower.includes('custom') || textLower === '2') {
                    resetInvalidCount(jid);
                    session.step = 'ENTER_CUSTOM_RANGE';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, { text: `🔢 *Enter Custom Page Range*:\n\nReply with your start and end page e.g. *"1-${session.pending.totalPages}"* or *"1,2"* (Total pages: ${session.pending.totalPages}):` });
                    return;
                } else {
                    await recordInvalidAttempt(sock, jid, `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for All Pages or *2* for Custom Page Range.`);
                    return;
                }
            }

            if (session.step === 'ENTER_CUSTOM_RANGE') {
                if (!isValidPageRange(rawText, session.pending.totalPages)) {
                    await recordInvalidAttempt(sock, jid, `⚠️ *Invalid Page Range ("${rawText}")!*\n\nTotal pages in file: *${session.pending.totalPages}*.\nPlease reply with a valid range between *1* and *${session.pending.totalPages}* e.g. *"1-${session.pending.totalPages}"* or *"1,2"*.`);
                    return;
                }

                resetInvalidCount(jid);
                session.pending.selectedPages = rawText.trim();
                session.step = 'SELECT_SIDES';
                saveSessions(sessions);

                await sendSmartMenu(
                    sock,
                    jid,
                    '📑 Print Sides (Single vs Duplex)',
                    `Page Range Set: *${rawText.trim()}*\n\nPlease choose print side orientation:`,
                    'Select Print Sides',
                    ['📄 Single Sided (Rs. 2/page)', '📑 Both Sides / Duplex (Rs. 2/paper)']
                );
                return;
            }

            if (session.step === 'SELECT_SIDES') {
                if (textLower.includes('single') || textLower === '1') {
                    resetInvalidCount(jid);
                    session.pending.doubleSided = false;
                    session.step = 'SELECT_COLOR';
                    saveSessions(sessions);

                    await sendSmartMenu(
                        sock,
                        jid,
                        '🎨 Select Print Color Mode',
                        'Please choose your print color mode below:',
                        'Select Color Mode',
                        ['⚫ Black & White (₹2/pg)', '🎨 Color (₹5/pg)']
                    );
                    return;
                } else if (textLower.includes('both') || textLower.includes('duplex') || textLower === '2') {
                    resetInvalidCount(jid);
                    session.pending.doubleSided = true;
                    session.step = 'SELECT_COLOR';
                    saveSessions(sessions);

                    await sendSmartMenu(
                        sock,
                        jid,
                        '🎨 Select Print Color Mode',
                        'Please choose your print color mode below:',
                        'Select Color Mode',
                        ['⚫ Black & White (₹2/pg)', '🎨 Color (₹5/pg)']
                    );
                    return;
                } else {
                    await recordInvalidAttempt(sock, jid, `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for Single Sided or *2* for Both Sides / Duplex.`);
                    return;
                }
            }

            if (session.step === 'SELECT_COLOR') {
                if (textLower.includes('bw') || textLower.includes('black') || textLower.includes('b&w') || textLower.includes('b/w') || textLower === '1') {
                    resetInvalidCount(jid);
                    session.pending.printType = 'BW';
                    session.step = 'ENTER_COPIES';
                    saveSessions(sessions);

                    await sock.sendMessage(jid, { text: `🔢 *Number of Copies*:\n\nReply with any number of copies you need (e.g. *1*, *2*, *5*, *10*, *25*, *50*, *100*, etc.):` });
                    return;
                } else if (textLower.includes('color') || textLower.includes('colour') || textLower === '2') {
                    const colorCheck = await checkKioskPrinterStatus(session.blockLocation, 'COLOR');
                    if (!colorCheck.available) {
                        await sock.sendMessage(jid, {
                            text: `⚠️ *Color Printing Unavailable*:\n${colorCheck.message}\n\nPlease choose *1* for Black & White (₹2/pg), or send a different choice:`
                        });
                        return;
                    }
                    resetInvalidCount(jid);
                    session.pending.printType = 'COLOR';
                    session.pending.doubleSided = false;
                    session.step = 'ENTER_COPIES';
                    saveSessions(sessions);

                    await sock.sendMessage(jid, { text: `🔢 *Number of Copies*:\n\nReply with any number of copies you need (e.g. *1*, *2*, *5*, *10*, *25*, *50*, *100*, etc.):` });
                    return;
                } else {
                    await recordInvalidAttempt(sock, jid, `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for Black & White (₹2/pg) or *2* for Color (₹5/pg).`);
                    return;
                }
            }

            if (session.step === 'ENTER_COPIES') {
                const match = rawText.match(/\b\d+\b/) || rawText.match(/\d+/);
                const c = match ? parseInt(match[0], 10) : 0;
                if (c < 1) {
                    await recordInvalidAttempt(sock, jid, `⚠️ *Please reply with a valid number of copies* (e.g. *1*, *2*, *5*, *10*, *20*, *50*, etc.):`);
                    return;
                }

                resetInvalidCount(jid);

                // Check paper availability for requested copies
                const isImage = Boolean(session.pending?.isImage);
                const pageCount = isImage ? 1 : countPagesFromRange(session.pending?.selectedPages, session.pending?.totalPages);
                let effectivePages = pageCount;
                if (session.pending?.layoutMode === '2-UP') effectivePages = Math.ceil(pageCount / 2.0);
                else if (session.pending?.layoutMode === '4-UP') effectivePages = Math.ceil(pageCount / 4.0);
                const div = session.pending?.doubleSided ? 2.0 : 1.0;
                const sheetsPerCopy = Math.ceil(effectivePages / div);
                const totalSheetsNeeded = sheetsPerCopy * c;

                const availablePaper = await getKioskPaperCount(session.blockLocation);

                if (availablePaper <= 0) {
                    await sock.sendMessage(jid, {
                        text: `🚨 *Kiosk Out of Paper (${session.blockLocation})*:\nThis kiosk is currently out of paper (0 sheets remaining in tray).\n\n👉 Please type *menu* to switch to another active kiosk block.`
                    });
                    await sendDirectAdminAlert(sock, `🚨 *OUT OF PAPER ALERT*\n━━━━━━━━━━━━━━━━━━━━━━\n📍 Location: *${session.blockLocation}*\n⚠️ Available Paper: *0 sheets*\n📱 User +91 ${senderPhone} attempted to print ${totalSheetsNeeded} sheets.\n👉 Refill paper immediately!`);
                    return;
                }

                if (totalSheetsNeeded > availablePaper) {
                    const maxCopies = Math.floor(availablePaper / Math.max(1, sheetsPerCopy));
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Insufficient Paper in Kiosk (${session.blockLocation})*:\n` +
                              `• Requested: *${c} copies* (*${totalSheetsNeeded} sheets* required)\n` +
                              `• Available in Tray: *${availablePaper} sheets*\n\n` +
                              `👉 Please reply with a smaller number of copies (maximum *${maxCopies > 0 ? maxCopies : 1} copies*), or type *menu* to switch to another kiosk with more paper.`
                    });
                    await sendDirectAdminAlert(sock, `⚠️ *LOW PAPER WARNING / CAPACITY EXCEEDED*\n━━━━━━━━━━━━━━━━━━━━━━\n📍 Location: *${session.blockLocation}*\n⚠️ Available Paper: *${availablePaper} sheets*\n📱 User +91 ${senderPhone} requested *${c} copies* (*${totalSheetsNeeded} sheets* needed).\n👉 Please inspect kiosk and refill paper tray!`);
                    return;
                }

                session.pending.copies = c;
                await showOrderSummary(sock, jid, session, sessions, senderPhone, senderName);
                return;
            }

            if (session.step === 'CONFIRM_ORDER') {
                const totalAmt = session.pending?.estimatedTotal || 0.0;
                const isCancel = textLower.includes('cancel') || textLower === '2' || textLower === 'no' || textLower === 'quit';

                resetInvalidCount(jid);

                if (isCancel) {
                    session.pending = null;
                    session.step = 'IDLE';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, { text: "❌ Order draft cancelled. You can attach a new file to print anytime!" });
                    return;
                }

                await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, totalAmt, sessions);
                return;
            }
        }

        // Friendly small talk for idle responses or unknown message rate limiting
        if (isRecognizedFriendlyIntent(textLower)) {
            resetInvalidCount(jid);
            const friendlyReply = getFriendlyChatResponse(textLower, rawText, senderName, session);
            await sock.sendMessage(jid, { text: friendlyReply });
        } else {
            await recordInvalidAttempt(sock, jid, 
                `❓ *Unrecognized Message or Command ("${rawText}")*\n\n` +
                `I'm your campus Cloud Print Assistant. I didn't recognize that command.\n\n` +
                `📎 *To Print*: Attach and send any **PDF or Image** right here!\n` +
                `💡 *Helpful Commands*:\n` +
                `• *hi* - Welcome greeting & kiosk status\n` +
                `• *receipt* - Official PDF receipt for your last print\n` +
                `• *block* - View online printers / switch kiosk\n` +
                `• *price* - View per-page pricing schedule\n` +
                `• *help* - Step-by-step instructions`
            );
        }

    } catch (error) {
        console.error("FULL WhatsApp message error:", error);
    }
}

async function showOrderSummary(sock, jid, session, sessions, senderPhone, senderName) {
    const isImage = Boolean(session.pending.isImage);
    const rawPageCount = isImage ? 1 : countPagesFromRange(session.pending.selectedPages, session.pending.totalPages);
    const layoutMode = session.pending.layoutMode || '1-UP';
    let effectivePages = rawPageCount;
    let layoutLabel = '1 Slide per Page (Standard)';
    if (layoutMode === '2-UP') {
        effectivePages = Math.ceil(rawPageCount / 2.0);
        layoutLabel = '2 Slides per Page (📑 50% Saver)';
    } else if (layoutMode === '4-UP') {
        effectivePages = Math.ceil(rawPageCount / 4.0);
        layoutLabel = '4 Slides per Page (📑 75% Super Saver)';
    }

    const rate = session.pending.printType === 'COLOR' ? 5.0 : (session.pending.doubleSided ? 1.50 : 2.0);
    const div = session.pending.doubleSided ? 2.0 : 1.0;
    const paperSheets = Math.ceil(effectivePages / div);
    const originalTotal = (session.pending.doubleSided && effectivePages === 1) ? 2.00 : paperSheets * (session.pending.copies || 1) * rate;

    let discountAmount = 0.0;
    let appliedCoupon = null;
    if (session.savedDiscountCoupon && session.savedDiscountCoupon.code) {
        appliedCoupon = session.savedDiscountCoupon.code;
        discountAmount = Number(session.savedDiscountCoupon.amount || 2.0);
    }

    const estimatedTotal = Math.max(0.0, originalTotal - discountAmount);
    session.pending.originalTotal = originalTotal;
    session.pending.discountAmount = discountAmount;
    session.pending.couponCode = appliedCoupon;
    session.pending.estimatedTotal = estimatedTotal;

    let userBalance = 0.0;
    try {
        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 4000 });
        if (balRes.data && balRes.data.balance !== undefined) {
            userBalance = parseFloat(balRes.data.balance) || 0.0;
        }
    } catch (e) {}

    session.pending.userBalance = userBalance;

    let priceSummary = `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n`;
    if (discountAmount > 0) {
        priceSummary = `💵 Original Total: *₹${originalTotal.toFixed(2)}*\n` +
                       `🏷️ Coupon Discount (*${appliedCoupon}*): *-₹${discountAmount.toFixed(2)}*\n` +
                       `💰 Final Amount: *₹${estimatedTotal.toFixed(2)}*` + (estimatedTotal <= 0 ? ' *(100% FREE PRINT)*' : '') + `\n`;
    }

    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
        `📄 File: *${session.pending.filename}*\n` +
        (isImage ? `🖼️ Type: *Photo / Image (1 Page)*\n` : `📊 Document Pages: *${rawPageCount}* (Range: ${session.pending.selectedPages})\n` +
         (layoutMode !== '1-UP' ? `📑 Layout: *${layoutLabel}*\n` : '') +
         `🖨️ Physical Sheets: *${paperSheets} sheet(s)* (${effectivePages} pages on paper)\n`) +
        (isImage ? `` : `📑 Sides: *${session.pending.doubleSided ? 'Both Sides (Duplex)' : 'Single Sided'}*\n`) +
        `🎨 Mode: *${session.pending.printType === 'COLOR' ? 'Color (₹5/pg)' : 'Black & White (₹2/pg)'}*\n` +
        `🔢 Copies: *${session.pending.copies || 1}*\n` +
        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
        priceSummary +
        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

    // 1. Send Order Summary
    await sock.sendMessage(jid, { text: summaryText });

    // 2. Directly create order on server and send Razorpay Payment Link or Wallet Confirmation
    await processOrderCreationAndPayment(sock, jid, session, senderName, senderPhone, estimatedTotal, sessions);
}

let orderMonitoringInterval = null;

function startOrderMonitoring() {
    if (orderMonitoringInterval) {
        clearInterval(orderMonitoringInterval);
        orderMonitoringInterval = null;
    }
    // Check orders every 5s for fast and responsive WhatsApp notifications
    orderMonitoringInterval = setInterval(async () => {
        try {
            const sessions = loadSessions();
            let updated = false;
            const nowMs = Date.now();

            for (const phone of Object.keys(sessions)) {
                const session = sessions[phone];
                // Only monitor if session has an active, unnotified or pending order
                if (session.lastOrderId && sock && !session.notifiedCompletion) {
                    try {
                        const targetJid = session.jid || (phone.endsWith('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`);

                        // 1. Fetch current order status from backend first
                        let data = {};
                        try {
                            const res = await axios.get(`${BACKEND_BASE}/api/pdf/details?orderId=${session.lastOrderId}`, { timeout: 5000 });
                            data = res.data || {};
                        } catch (err) {
                            if (err.response?.status === 404) {
                                console.log(`ℹ️ Order ${session.lastOrderId} not found on backend (404). Clearing stale order.`);
                                session.lastOrderId = null;
                                session.lastOtp = null;
                                session.printingNotified = false;
                                session.paymentNotified = false;
                                session.notifiedCancelled = false;
                                session.notifiedCompletion = false;
                                updated = true;
                                continue;
                            }
                        }

                        const isPaid = (data.paymentStatus === 'PAID' || data.status === 'PAID' || data.status === 'CANCEL_WINDOW' || data.status === 'PENDING_SCAN' || data.status === 'QUEUE' || data.status === 'PRINTING' || data.status === 'COMPLETED');

                        // 2. Post-Payment Confirmation Notice with Exact Expiry Time
                        if (isPaid && !session.paymentNotified) {
                            const expiryDate = new Date(nowMs + 10 * 60 * 1000);
                            const expiryTimeStr = expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

                            const userOtp = data.otpCode || session.lastOtp || '';
                            const msgText = `✅ *Payment Confirmed for Order ${session.lastOrderId}!* 🎉\n\n` +
                                            `📍 *Target Kiosk*: *${session.blockLocation || data.blockLocation || 'Campus Kiosk'}*\n` +
                                            `📺 *Release OTP*: Look at the *Kiosk TV Display Screen* at *${session.blockLocation || data.blockLocation || 'Campus Kiosk'}* for your 4-digit code!\n` +
                                            `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                                            `👉 *Whenever you are near the ${session.blockLocation || data.blockLocation || 'Campus Kiosk'} printer, look at the TV screen for your 4-digit code and reply with it here in WhatsApp* to release your print directly to the printer tray!`;

                            await sock.sendMessage(targetJid, { text: msgText });
                            session.paymentNotified = true;
                            session.printingNotified = false;
                            if (userOtp) session.lastOtp = userOtp;
                            session.paidTimestamp = nowMs;
                            session.lastReminderTimestamp = nowMs;
                            updated = true;
                        }

                        // 3. Printing in Progress Notification
                        if ((data.status === 'QUEUE' || data.status === 'PRINTING') && !session.printingNotified && !session.notifiedCompletion) {
                            const printingMsg = `🖨️ *Printing in Progress for Order ${session.lastOrderId}!* ⚡\n\n` +
                                                `📍 *Target Kiosk*: *${session.blockLocation || data.blockLocation || 'Campus Kiosk'}*\n` +
                                                `📄 *Document*: *${data.fileName || 'Document.pdf'}* (${data.totalPages || 1} page(s), ${data.copies || 1} copy)\n\n` +
                                                `Your pages are actively printing right now in the kiosk tray! Please stand by to collect your pages. 🎉`;
                            await sock.sendMessage(targetJid, { text: printingMsg });
                            session.printingNotified = true;
                            updated = true;
                        }

                        // 4. Auto-cancel Unpaid Orders only if NOT paid after 5 Minutes (300,000 ms)
                        if (!isPaid && !session.paymentNotified && session.orderCreatedTimestamp) {
                            const unpaidElapsed = nowMs - session.orderCreatedTimestamp;
                            if (unpaidElapsed >= 300000) { // 5 minutes
                                try {
                                    await axios.post(`${BACKEND_BASE}/api/pdf/cancel`, null, {
                                        params: { orderId: session.lastOrderId }
                                    }).catch(() => {});
                                } catch (e) {}

                                const timeoutMsg = `⏰ *Order ${session.lastOrderId} Cancelled (Payment Timeout)*\n\n` +
                                                   `Your print order was automatically cancelled because payment was not confirmed within 5 minutes.\n\n` +
                                                   `📄 *Need to print?* Simply attach and send your document again to create a new order anytime!`;

                                await sock.sendMessage(targetJid, { text: timeoutMsg });
                                session.lastOrderId = null;
                                session.lastOtp = null;
                                session.pending = null;
                                session.step = 'IDLE';
                                session.orderCreatedTimestamp = null;
                                session.printingNotified = false;
                                session.paymentNotified = false;
                                updated = true;
                                continue;
                            }
                        }

                        // 5. Periodic 2-Minute Expiry Reminder
                        if ((data.status === 'PENDING_SCAN' || data.status === 'CANCEL_WINDOW' || data.status === 'PAID') && session.paymentNotified && !session.otpReleased) {
                            const lastReminder = session.lastReminderTimestamp || session.paidTimestamp || 0;
                            const timeSincePaid = nowMs - (session.paidTimestamp || nowMs);
                            const totalLimitMs = 15 * 60 * 1000;
                            const remainingMs = Math.max(0, totalLimitMs - timeSincePaid);
                            const minutesLeft = Math.ceil(remainingMs / 60000);

                            if (nowMs - lastReminder >= 120000 && minutesLeft > 0) {
                                const reminderText = `⏰ *REMINDER: Print Order Pending Release (${session.lastOrderId})!*\n\n` +
                                                     `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                                     `📺 *Release OTP*: Displayed on *${session.blockLocation || 'Campus Kiosk'} TV Display Screen*\n` +
                                                     `⏳ *Time Remaining Before Expiry*: *${minutesLeft} minute(s)*\n\n` +
                                                     `👉 *Look at the TV Display screen for your 4-digit OTP and reply with it here in WhatsApp* to release your print at ${session.blockLocation || 'Campus Kiosk'} before time expires!`;

                                await sock.sendMessage(targetJid, { text: reminderText });
                                session.lastReminderTimestamp = nowMs;
                                updated = true;
                            }
                        }

                        // 6. Print Completed Notification & Ask for Receipt
                        if (data.status === 'COMPLETED' && !session.notifiedCompletion) {
                            const priceVal = data.price || session.lastPrice || 0;
                            const priceFormatted = typeof priceVal === 'number' ? priceVal : (parseFloat(priceVal) || 0);
                            const origPriceVal = Number(data.originalPrice != null ? data.originalPrice : (session.lastOriginalPrice || priceFormatted));
                            const discountVal = Number(data.discountAmount != null ? data.discountAmount : (session.lastDiscountAmount || (origPriceVal > priceFormatted ? (origPriceVal - priceFormatted) : 0)));
                            let actualPaid = priceFormatted;
                            if (discountVal >= origPriceVal && origPriceVal > 0) {
                                actualPaid = 0;
                            }
                            const isCouponPayment = actualPaid <= 0 || (discountVal >= origPriceVal && origPriceVal > 0);

                            session.completedOrderData = {
                                orderId: session.lastOrderId || data.orderId,
                                fileName: data.fileName || 'Document.pdf',
                                totalPages: data.totalPages || 1,
                                doubleSided: data.doubleSided || false,
                                printType: data.printType || 'BW',
                                copies: data.copies || 1,
                                price: actualPaid,
                                originalPrice: origPriceVal,
                                discountAmount: discountVal > 0 ? discountVal : (isCouponPayment ? origPriceVal : 0),
                                blockLocation: session.blockLocation || data.blockLocation || 'Campus Kiosk',
                                transactionId: isCouponPayment ? 'COUPON PAYMENT (₹0.00 PAID)' : (data.razorpayPaymentId || 'WALLET_PAYMENT'),
                                paymentMethod: isCouponPayment ? 'Coupon / 100% Wallet Discount' : (data.orderChannel === 'WHATSAPP' ? 'WhatsApp Cloud Print' : 'Web Portal'),
                                paidAt: data.paidAt || Date.now()
                            };

                            const completionMsg = `🎉 *Print Job Complete!* 🖨️\n\n` +
                                                  `Your document has been printed and is ready in the *${session.blockLocation || data.blockLocation || 'Campus Kiosk'}* tray. Please collect your pages!\n\n` +
                                                  `🧾 *Would you like an Official Payment Receipt PDF?*\n` +
                                                  `1️⃣  *Yes, send receipt*\n` +
                                                  `2️⃣  *No, thank you*\n\n` +
                                                  `👉 *Reply with 1 or 2*`;

                            await sock.sendMessage(targetJid, { text: completionMsg });

                            session.step = 'ASK_RECEIPT';
                            session.receiptAskTimestamp = nowMs;
                            session.notifiedCompletion = true;
                            session.printingNotified = false;
                            updated = true;
                        }

                        // 7. Check if ASK_RECEIPT timed out (3 minutes = 180,000 ms) with no response
                        if (session.step === 'ASK_RECEIPT' && session.receiptAskTimestamp && (nowMs - session.receiptAskTimestamp > 180000)) {
                            await sock.sendMessage(targetJid, { text: "🥰 *Thank you for using Cloud Print!* Have a wonderful day! 🖨️✨" });
                            session.step = 'IDLE';
                            session.completedOrderData = null;
                            session.lastOrderId = null;
                            session.lastOtp = null;
                            session.otpReleased = true;
                            session.receiptAskTimestamp = null;
                            session.notifiedCompletion = false;
                            session.paymentNotified = false;
                            session.printingNotified = false;
                            session.pending = null;
                            updated = true;
                        }

                        // 8. Timeout Expiry / Cancellation Notification with 7-Day Refund Coupon (ONLY for PAID orders)
                        if ((data.status === 'CANCELLED' || data.status === 'EXPIRED' || data.status === 'FAILED') && !session.notifiedCancelled && !session.notifiedCompletion && !session.otpReleased) {
                            const isPaid = (data.paymentStatus === 'PAID' || Boolean(session.paidTimestamp && session.paymentNotified));
                            const refundVal = data.price || session.lastPrice || 0.0;
                            const refundNum = typeof refundVal === 'number' ? refundVal : (parseFloat(refundVal) || 0.0);

                            if (isPaid && refundNum > 0) {
                                const couponCode = await generateRefundCoupon(refundNum);

                                const statusTitle = data.status === 'FAILED' 
                                    ? `⚠️ *Print Job Error for Order ${session.lastOrderId}*`
                                    : `⏰ *Order ${session.lastOrderId} Expired / Cancelled*`;

                                const statusDesc = data.status === 'FAILED'
                                    ? `Our kiosk encountered an issue while printing your pages.`
                                    : `The release OTP was not entered at the kiosk within the time limit.`;

                                const msgText = `${statusTitle}\n\n` +
                                                `${statusDesc}\n\n` +
                                                `🎟️ *100% REFUND COUPON GENERATED*:\n` +
                                                `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                                `💰 *Refund Value*: *₹${refundNum.toFixed(2)}*\n` +
                                                `🏷️ *Coupon Code*: *${couponCode}*\n` +
                                                `⏰ *Validity*: *7 Days* (Single Use Only)\n` +
                                                `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                                `💡 *How to Redeem*:\n` +
                                                `1. Reply *"COUPON ${couponCode}"* right here in WhatsApp to add ₹${refundNum.toFixed(2)} to your wallet balance instantly!\n` +
                                                `2. Or enter code *${couponCode}* on the checkout page of your next order.`;

                                await sock.sendMessage(targetJid, { text: msgText });
                            } else {
                                const timeoutMsg = `⏰ *Unpaid Order ${session.lastOrderId} Cancelled*\n\n` +
                                                   `Your print order was cancelled because payment was not completed within the time limit. No charges were applied. You can attach a new document to print anytime!`;
                                await sock.sendMessage(targetJid, { text: timeoutMsg });
                            }
                            session.lastOrderId = null;
                            session.lastOtp = null;
                            session.printingNotified = false;
                            session.paymentNotified = false;
                            session.paidTimestamp = null;
                            session.notifiedCancelled = true;
                            updated = true;
                        }

                    } catch (err) {
                        if (err.response && err.response.status === 404) {
                            console.log(`ℹ️ Order ${session.lastOrderId} not found on backend (404). Clearing stale order monitoring.`);
                            session.lastOrderId = null;
                            session.lastOtp = null;
                            session.paymentNotified = false;
                            updated = true;
                        } else {
                            console.error("Order monitoring error:", err.message);
                        }
                    }
                }
            }

            // 5. Poll Hardware & Paper Level Alerts and Dispatch to Admin WhatsApp (+91 9494189664)
            try {
                let alertList = [];
                try {
                    const alertsRes1 = await axios.get(`${BACKEND_BASE}/api/alerts/pending`, { timeout: 5000 });
                    if (alertsRes1.data && Array.isArray(alertsRes1.data)) alertList.push(...alertsRes1.data);
                } catch (e) {}
                try {
                    const alertsRes2 = await axios.get(`${BACKEND_BASE}/api/printer/alerts/pending`, { timeout: 5000 });
                    if (alertsRes2.data && Array.isArray(alertsRes2.data)) {
                        for (const a of alertsRes2.data) {
                            if (!alertList.some(x => x.id === a.id)) alertList.push(a);
                        }
                    }
                } catch (e) {}

                if (alertList.length > 0) {
                    for (const alert of alertList) {
                        const alertMsg = alert.message || `🚨 *CLOUD PRINT KIOSK ALERT*\n━━━━━━━━━━━━━━━━━━━━━━\n📍 *Location*: ${alert.blockLocation || 'Campus Kiosk'}\n⚠️ *Status*: *${alert.alertType || 'ALERT'}*\n📝 *Details*: ${alert.details || 'Hardware alert'}\n⏱️ *Time*: ${alert.timestamp || new Date().toLocaleString()}`;
                        await sendDirectAdminAlert(sock, alertMsg);
                        
                        // Acknowledge alert
                        if (alert.id) {
                            await axios.post(`${BACKEND_BASE}/api/alerts/ack?id=${encodeURIComponent(alert.id)}`, null, { timeout: 5000 }).catch(() => {});
                            await axios.post(`${BACKEND_BASE}/api/printer/alerts/ack?id=${encodeURIComponent(alert.id)}`, null, { timeout: 5000 }).catch(() => {});
                        }
                    }
                }
            } catch (e) {}

            if (updated) saveSessions(sessions);
        } catch (e) {}
    }, 5000);
}

startBot();
