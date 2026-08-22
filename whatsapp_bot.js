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

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const BACKEND_URL = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
const BACKEND_BASE = process.env.BACKEND_BASE_URL || 'https://printer-backend-kgzp.onrender.com';
const FRONTEND_BASE = process.env.FRONTEND_URL || 'https://cloudprint.website';
const SESSIONS_FILE = path.join(__dirname, 'user_sessions.json');
const AUTH_DIR = path.join(__dirname, '.baileys_auth');

console.log('⚡ Initializing Cloud Print WhatsApp Agent (Baileys Direct Engine)...');

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load user_sessions.json:', e);
    }
    return {};
}

function saveSessions(sessions) {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save user_sessions.json:', e);
    }
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
        const res = await axios.get(`${BACKEND_BASE}/api/blocks/online`, { timeout: 15000 });
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
            const map = {};
            res.data.forEach(item => {
                const col = item.college || 'Campus';
                if (!map[col]) map[col] = [];
                if (item.name && !map[col].includes(item.name)) {
                    map[col].push(item.name);
                }
            });
            cachedCollegesMap = map;
            lastCollegesFetchTime = now;
            return map;
        }
    } catch (e) {
        console.error('Online blocks lookup notice (using cache):', e.message);
    }

    if (cachedCollegesMap) return cachedCollegesMap;

    return {
        "KLU": ["C Block"]
    };
}

async function checkKioskPrinterStatus(blockLocation, printType = 'BW') {
    if (!blockLocation) return { available: false, message: 'No kiosk block specified' };
    try {
        const res = await axios.get(`${BACKEND_BASE}/api/printer/availability?blockLocation=${encodeURIComponent(blockLocation)}&printType=${printType}`, { timeout: 10000 });
        if (res.data) {
            return {
                available: Boolean(res.data.available),
                message: res.data.message || (res.data.available ? 'Printer is available' : 'The printer at this block is currently offline or unassigned.')
            };
        }
    } catch (e) {
        console.error(`Printer status check notice for ${blockLocation}:`, e.message);
    }

    try {
        const sysRes = await axios.get(`${BACKEND_BASE}/api/system/status?blockLocation=${encodeURIComponent(blockLocation)}`, { timeout: 10000 });
        if (sysRes.data) {
            const isOnline = Boolean(sysRes.data.available && sysRes.data.printerConfigured);
            return {
                available: isOnline,
                message: isOnline ? 'Printer is available' : 'The printer at this kiosk block is currently offline or under maintenance.'
            };
        }
    } catch (sysErr) {
        console.error(`System status check error for ${blockLocation}:`, sysErr.message);
    }
    return { available: false, message: `Could not connect to the print server for ${blockLocation}. Please select another active kiosk.` };
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

function createUploadFormData(session, senderName, senderPhone) {
    const buffer = Buffer.from(session.pending.bufferBase64, 'base64');
    const form = new FormData();
    form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype });
    form.append('customerName', `${senderName} (${senderPhone})`);
    form.append('phoneNumber', senderPhone);
    form.append('blockLocation', session.blockLocation || 'Campus Kiosk');
    form.append('printType', session.pending.printType || 'BW');
    form.append('selectedPages', session.pending.selectedPages || 'ALL');
    form.append('doubleSided', session.pending.doubleSided ? 'true' : 'false');
    form.append('copies', String(session.pending.copies || 1));
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
               `3️⃣ *Collect Print*: Reply with your 4-digit OTP right here in WhatsApp when you are at *${session.blockLocation || 'C Block'}* to release your print directly to the printer tray!\n\n` +
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
    const { height } = page.getSize();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Header Banner
    page.drawRectangle({
        x: 0,
        y: height - 120,
        width: 595.28,
        height: 120,
        color: rgb(0.01, 0.52, 0.78),
    });

    page.drawText('CLOUD PRINT KIOSK', {
        x: 40,
        y: height - 50,
        size: 24,
        font: fontBold,
        color: rgb(1, 1, 1),
    });

    page.drawText('OFFICIAL PRINT RECEIPT', {
        x: 40,
        y: height - 80,
        size: 14,
        font: fontRegular,
        color: rgb(0.85, 0.95, 1),
    });

    let y = height - 160;

    const drawRow = (label, value) => {
        page.drawText(label, { x: 50, y, size: 12, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
        page.drawText(String(value), { x: 220, y, size: 12, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
        page.drawLine({
            start: { x: 50, y: y - 8 },
            end: { x: 545, y: y - 8 },
            thickness: 0.5,
            color: rgb(0.9, 0.9, 0.9),
        });
        y -= 35;
    };

    drawRow('Order ID:', orderData.orderId);
    drawRow('Document Name:', orderData.fileName);
    drawRow('Total Pages:', `${orderData.totalPages} Page(s)`);
    drawRow('Print Format:', orderData.doubleSided ? 'Both Sides (Duplex)' : 'Single Sided');
    drawRow('Color Mode:', orderData.printType === 'COLOR' ? 'Color' : 'Black & White');
    drawRow('Number of Copies:', orderData.copies);
    drawRow('Total Amount Paid:', `INR ${orderData.price.toFixed(2)}`);
    drawRow('Payment Method:', 'Razorpay Online Payment');
    drawRow('Collection Kiosk:', orderData.blockLocation);
    drawRow('Completion Time:', new Date().toLocaleString());

    // Footer Box
    page.drawRectangle({
        x: 40,
        y: 40,
        width: 515,
        height: 60,
        color: rgb(0.94, 0.98, 1),
        borderColor: rgb(0.01, 0.52, 0.78),
        borderWidth: 1,
    });

    page.drawText('Thank you for using Cloud Print Kiosk!', {
        x: 160,
        y: 75,
        size: 13,
        font: fontBold,
        color: rgb(0.01, 0.52, 0.78),
    });

    page.drawText('Please collect your printed document from the printer tray.', {
        x: 120,
        y: 52,
        size: 10,
        font: fontRegular,
        color: rgb(0.3, 0.3, 0.3),
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
        if (footerText) {
            menuText += `\n\n_${footerText}_`;
        }
        await sock.sendMessage(targetJid, { text: menuText });
    } catch (e) {
        console.error("Send menu error:", e);
    }
}

let sock = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Cloud Print Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 SCAN THIS QR CODE WITH YOUR WHATSAPP PHONE (Linked Devices):\n');
            qrcode.generate(qr, { small: true });

            try {
                const dataUrl = await QRCodeImage.toDataURL(qr, { width: 320, margin: 2 });
                const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>WhatsApp Bot QR Code</title>
<style>
  body { background: #0f172a; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
  .card { background: white; padding: 32px; border-radius: 24px; text-align: center; color: #0f172a; box-shadow: 0 25px 50px rgba(0,0,0,0.5); }
  img { border-radius: 12px; border: 2px solid #e2e8f0; width: 280px; height: 280px; }
  h1 { color: #0284c7; margin: 0 0 8px 0; font-size: 22px; }
  p { color: #64748b; margin: 0 0 20px 0; font-size: 14px; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
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
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.messages.length === 0) return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            await handleIncomingMessage(msg);
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

        // Cancel order command
        if (textLower === 'cancel' || textLower === 'cancel order' || textLower === '/cancel') {
            if (session.lastOrderId) {
                const targetId = session.lastOrderId;
                const wasPaid = Boolean(session.paymentNotified);

                session.lastOrderId = null;
                session.lastOtp = null;
                session.paymentNotified = false;
                session.pending = null;
                session.step = 'IDLE';
                saveSessions(sessions);

                if (wasPaid) {
                    const refundVal = session.lastPrice || 4.0;
                    const couponCode = await generateRefundCoupon(refundVal);
                    const refundMsg = `❌ *Order ${targetId} Cancelled!*\n\n` +
                                      `🎟️ *PRINT REFUND COUPON GENERATED*:\n` +
                                      `-----------------------------------------\n` +
                                      `💰 *Refund Value*: *₹${refundVal.toFixed(2)}*\n` +
                                      `🏷️ *Coupon Code*: *${couponCode}*\n` +
                                      `⏰ *Validity*: *7 Days* (Single Use Only)\n` +
                                      `-----------------------------------------\n` +
                                      `💡 Send *"COUPON ${couponCode}"* right here in WhatsApp to credit ₹${refundVal.toFixed(2)} to your wallet!`;

                    await sock.sendMessage(jid, { text: refundMsg });
                } else {
                    await sock.sendMessage(jid, { text: `❌ *Unpaid Order ${targetId} Cancelled!*\n\nYou can attach and send a new document to print anytime.` });
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

        // Check for Coupon Redemption e.g. "COUPON 123456", "REDEEM 123456", or 6-digit code e.g. "123456"
        const couponMatch = rawText.match(/^(?:coupon|redeem)\s*([a-zA-Z0-9]+)$/i) || (/^\d{6}$/.test(rawText.trim()) ? [null, rawText.trim()] : null);
        if (couponMatch) {
            const codeToRedeem = couponMatch[1] || rawText.trim();
            try {
                const redeemRes = await axios.post(`${BACKEND_BASE}/api/bot/redeem-coupon?phoneNumber=${senderPhone}&couponCode=${codeToRedeem}`, null, { timeout: 8000 });
                const rData = redeemRes.data || {};
                if (rData.success) {
                    const couponSuccessMsg = `🎉 *Coupon Redeemed Successfully!* 🎟️\n` +
                                             `-----------------------------------\n` +
                                             `💰 *Amount Credited*: *₹${(rData.creditedAmount || 0.0).toFixed(2)}*\n` +
                                             `💳 *Your New Wallet Balance*: *₹${(rData.newBalance || 0.0).toFixed(2)}*\n\n` +
                                             `💡 Whenever you print, your wallet balance can be used for instant 1-click payment!`;
                    await sock.sendMessage(jid, { text: couponSuccessMsg });
                    return;
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Coupon Redemption Failed*: ${rData.message || 'Invalid code'}` });
                    return;
                }
            } catch (cErr) {
                console.error("Coupon redemption error:", cErr.message);
                await sock.sendMessage(jid, { text: "⚠️ Could not redeem coupon right now. Please try again." });
                return;
            }
        }

        // Check for Wallet / Balance Inquiry e.g. "balance", "wallet", "my balance"
        if (textLower === 'balance' || textLower === 'wallet' || textLower === 'my balance' || textLower === '/balance' || textLower === '/wallet') {
            try {
                const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 5000 });
                const userBal = balRes.data?.balance || 0.0;
                const balMsg = `💳 *Cloud Print WhatsApp Wallet* 😊\n` +
                               `-----------------------------------\n` +
                               `📱 *Registered Phone*: *${senderPhone}*\n` +
                               `💰 *Available Balance*: *₹${userBal.toFixed(2)}*\n\n` +
                               `💡 Send any valid Coupon Code e.g. *"COUPON 123456"* to add funds to your wallet!`;
                await sock.sendMessage(jid, { text: balMsg });
                return;
            } catch (bErr) {
                await sock.sendMessage(jid, { text: `💳 *Wallet Balance*: ₹0.00` });
                return;
            }
        }

        // Check if user is entering 4-Digit Release OTP (Processed FIRST before Active Lock)
        if (/^\d{4}$/.test(rawText)) {
            let activeOrderToRelease = session.lastOrderId;

            if (!activeOrderToRelease) {
                try {
                    const pendingRes = await axios.get(`${BACKEND_BASE}/api/pdf/pendingScan?userId=${senderPhone}&blockLocation=${session.blockLocation || ''}`);
                    if (pendingRes.data && Array.isArray(pendingRes.data) && pendingRes.data.length > 0) {
                        activeOrderToRelease = pendingRes.data[0].orderId;
                    }
                } catch (e) {}
            }

            if (activeOrderToRelease) {
                try {
                    const releaseRes = await axios.post(`${BACKEND_BASE}/api/pdf/releasePrint?orderId=${activeOrderToRelease}&otp=${rawText.trim()}`, null, { timeout: 10000 });
                    if (releaseRes.data) {
                        await sock.sendMessage(jid, {
                            text: `✅ *OTP Verified (${rawText.trim()})!*\n\n🖨️ *Print Job Spooling...* Your document is being printed right now at *${session.blockLocation || 'Kiosk'}* printer tray.\n\nReceipt & pickup notification will be sent upon completion!`
                        });
                        session.otpReleased = true;
                        saveSessions(sessions);
                        return;
                    }
                } catch (otpErr) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Incorrect OTP ("${rawText.trim()}")!*\n\nPlease check your 4-digit Release OTP and reply with the correct code here in WhatsApp to release your print at *${session.blockLocation || 'Campus Kiosk'}*.`
                    });
                    return;
                }
            }
        }

        // Active Order Lock: If user has an unreleased active order, guide them to enter OTP in WhatsApp
        if (session.lastOrderId && !session.otpReleased && !session.pending) {
            await sock.sendMessage(jid, {
                text: `🔐 *Enter OTP to Release Print (*${session.lastOrderId}*)!*\n\n` +
                      `📍 *Target Kiosk*: ${session.blockLocation || 'Campus Kiosk'}\n` +
                      (session.lastOtp ? `🔐 *Your OTP*: *${session.lastOtp}*\n\n` : '\n') +
                      `👉 *Please reply with your 4-digit OTP right here in WhatsApp* to release and print your pages directly!\n\n` +
                      `❌ *To cancel*: Reply *cancel* to cancel this order and refund.`
            });
            return;
        }

        // Secret Admin command "CC" to reset / change college (hidden from regular user menus)
        if (textLower === 'cc' || textLower === '/cc' || textLower.includes('change college') || textLower.includes('change shop')) {
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

        // 1. College Selection
        if (!session.college) {
            let chosenCollege = null;

            if (session.step === 'SELECT_COLLEGE') {
                const found = collegeList.find(c => textLower.includes(c.toLowerCase()) || rawText.includes(c));
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
                saveSessions(sessions);

                const blocks = collegesMap[chosenCollege] || [];
                if (blocks.length === 0) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *All Kiosks in ${chosenCollege} are Currently Offline!*\n\nOur system detected that all printers in *${chosenCollege}* are currently inactive or under maintenance.\n\nPlease try again shortly, or reply *"CC"* to choose another campus/print shop.`
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
            } else if (session.step === 'SELECT_COLLEGE') {
                await sendSmartMenu(
                    sock,
                    jid,
                    '⚠️ Invalid Choice',
                    `Please select a valid College / Print Shop number (1 to ${collegeList.length}) or reply with the college name below:`,
                    'Select College / Shop',
                    collegeList.map(c => `🏫 ${c}`)
                );
                return;
            } else {
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
        if (session.step === 'SELECT_BLOCK' || !session.blockLocation) {
            const blocks = collegesMap[session.college] || [];
            if (blocks.length === 0) {
                await sock.sendMessage(jid, {
                    text: `⚠️ *No Online Printers Found in ${session.college || 'Selected Campus'}!*\n\nAll printers in this campus are currently offline or under maintenance.\n\nReply *"CC"* to switch college/shop or check back soon!`
                });
                return;
            }

            let chosenBlock = null;

            const found = blocks.find(b => textLower.includes(b.toLowerCase()) || rawText.includes(b));
            if (found) chosenBlock = found;
            else {
                const num = parseInt(rawText, 10);
                if (!isNaN(num) && num >= 1 && num <= blocks.length) {
                    chosenBlock = blocks[num - 1];
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
            } else if (session.step === 'SELECT_BLOCK') {
                await sendSmartMenu(
                    sock,
                    jid,
                    `⚠️ Invalid Choice (${session.college})`,
                    `Please select a valid online kiosk number (1 to ${blocks.length}) below:`,
                    'Select Kiosk Block',
                    blocks.map(b => `🟢 📍 ${b}`)
                );
                return;
            } else {
                session.step = 'SELECT_BLOCK';
                saveSessions(sessions);

                await sendSmartMenu(
                    sock,
                    jid,
                    `🟢 Online Kiosks (${session.college})`,
                    'Please select an active, online kiosk block below:',
                    'Select Kiosk Block',
                    blocks.map(b => `🟢 📍 ${b}`)
                );
                return;
            }
        }

        // 3. Document / Media Attachment Received
        const docMsg = messageContent?.documentMessage || messageContent?.documentWithCaptionMessage?.message?.documentMessage;
        const imgMsg = messageContent?.imageMessage;

        if (docMsg || imgMsg) {
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
                        text: `⚠️ *Kiosk Offline Alert*:\nYour selected kiosk (*${session.blockLocation}*) is currently offline or under maintenance.\n\n` +
                              `Please select an active online kiosk block below before uploading your document:`
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

            await sock.sendMessage(jid, { text: "⏳ *Downloading and analyzing your document via Baileys Direct Engine... Please wait.*" });

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

            session.pending = {
                filename,
                mimetype: isImage ? (mimetype.startsWith('image/') ? mimetype : 'image/jpeg') : mimetype,
                isImage,
                bufferBase64: buffer.toString('base64'),
                totalPages,
                selectedPages: 'ALL',
                doubleSided: false,
                printType: 'BW',
                copies: initialCopies
            };
            session.step = 'SELECT_PRINT_MODE';
            saveSessions(sessions);

            if (isImage) {
                await sendSmartMenu(
                    sock,
                    jid,
                    `🖼️ Photo Received: ${filename}`,
                    `📷 *Photo / Image (1 Page)*\n📍 Target Kiosk: *${session.blockLocation}* (${session.college})\n\nHow would you like to print this photo?`,
                    'Select Print Option',
                    [
                        '⚡ Quick Print (B&W • 1 Copy • ₹2)',
                        '🎨 Print in Color (₹5)',
                        '⚙️ Customize Color & Copies'
                    ]
                );
            } else {
                await sendSmartMenu(
                    sock,
                    jid,
                    `📄 Document Received: ${filename}`,
                    `📊 Total Pages Detected: *${totalPages}*\n📍 Target Kiosk: *${session.blockLocation}* (${session.college})\n\nHow would you like to print?`,
                    'Select Print Mode',
                    [
                        '⚡ Quick Print (All Pages, Single Sided, B&W)',
                        '⚙️ Customize Print Settings'
                    ]
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

                if (textLower.includes('quick') || textLower === '1') {
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = false;
                    session.pending.printType = 'BW';
                    session.pending.copies = 1;

                    const pageCount = countPagesFromRange('ALL', session.pending.totalPages);
                    const rate = 2.0;
                    const estimatedTotal = pageCount * rate;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 4000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
                        }
                    } catch (e) {}

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

                    // 1. If user has enough wallet balance, pay via wallet instantly
                    if (userBalance >= estimatedTotal && estimatedTotal > 0) {
                        await sock.sendMessage(jid, { text: "⏳ *Processing instant 1-Tap Wallet Payment...*" });
                        try {
                            const remoteForm = createUploadFormData(session, senderName, senderPhone);
                            const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                            const response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
                            const resData = response.data || {};
                            const orderId = resData.orderId || 'ORD2026';

                            const walletRes = await axios.post(`${BACKEND_BASE}/api/bot/pay-via-wallet?orderId=${orderId}&phoneNumber=${senderPhone}`, null, { timeout: 30000 });
                            const wData = walletRes.data || {};
                            if (wData.success) {
                                const expiryDate = new Date(Date.now() + 10 * 60 * 1000);
                                const userOtp = resData.otp || '';
                                const paidMsg = `✅ *Payment Successful via Wallet Balance!* 🎉\n` +
                                                `-----------------------------------\n` +
                                                `💰 *Amount Paid*: *₹${estimatedTotal.toFixed(2)}*\n` +
                                                `💳 *Remaining Wallet Balance*: *₹${(wData.newBalance || 0.0).toFixed(2)}*\n` +
                                                `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                                (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                                `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                                                `👉 *Whenever you are near the ${session.blockLocation || 'Campus Kiosk'} printer, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp* to release your print directly to the tray!`;

                                await sock.sendMessage(jid, { text: paidMsg });

                                session.lastOrderId = orderId;
                                session.lastOtp = userOtp;
                                session.lastPrice = estimatedTotal;
                                session.otpReleased = false;
                                session.paymentNotified = true;
                                session.paidTimestamp = Date.now();
                                session.lastReminderTimestamp = Date.now();
                                session.pending = null;
                                session.step = 'IDLE';
                                saveSessions(sessions);
                                return;
                            }
                        } catch (wErr) {
                            console.error("Quick Print wallet payment error:", wErr.message);
                        }
                    }

                    // 2. Otherwise generate and send direct Razorpay Payment Link right away
                    await sock.sendMessage(jid, { text: "⏳ *Generating online payment link...*" });
                    try {
                        const remoteForm = createUploadFormData(session, senderName, senderPhone);
                        const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                        const response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
                        const resData = response.data || {};
                        const orderId = resData.orderId || 'ORD2026';
                        const paymentUrl = resData.paymentUrl || `${FRONTEND_BASE}/pay?orderId=${orderId}`;
                        const userOtp = resData.otp || '';

                        const payMsg = `💳 *Pay Online via Razorpay*:\n${paymentUrl}\n\n` +
                                     (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                     `⏳ *Payment Window*: *3 Minutes* (Order automatically cancels if unpaid within 3 minutes)\n\n` +
                                     `Tap the link above to complete your UPI/Card payment! Once paid, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp to print at *${session.blockLocation || 'your campus kiosk'}*!`;
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
                    } catch (remoteErr) {
                        console.error("Quick Print order creation failed:", remoteErr.message);
                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        await sock.sendMessage(jid, { text: "❌ *Transaction Failed*: Could not generate payment link right now. Please try again later." });
                        return;
                    }
                } else if (session.pending.isImage && (textLower.includes('color') || textLower.includes('colour') || textLower === '2')) {
                    const colorCheck = await checkKioskPrinterStatus(session.blockLocation, 'COLOR');
                    if (!colorCheck.available) {
                        await sock.sendMessage(jid, {
                            text: `⚠️ *Color Printing Unavailable*:\n${colorCheck.message}\n\nPlease choose *1* for Black & White (₹2), or select a different option:`
                        });
                        return;
                    }
                    session.pending.selectedPages = 'ALL';
                    session.pending.doubleSided = false;
                    session.pending.printType = 'COLOR';
                    session.pending.copies = 1;

                    const estimatedTotal = 5.0;
                    session.pending.estimatedTotal = estimatedTotal;

                    let userBalance = 0.0;
                    try {
                        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 4000 });
                        if (balRes.data && balRes.data.balance !== undefined) {
                            userBalance = parseFloat(balRes.data.balance) || 0.0;
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

                    // 1. Wallet payment
                    if (userBalance >= estimatedTotal && estimatedTotal > 0) {
                        await sock.sendMessage(jid, { text: "⏳ *Processing instant 1-Tap Wallet Payment...*" });
                        try {
                            const remoteForm = createUploadFormData(session, senderName, senderPhone);
                            const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                            const response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
                            const resData = response.data || {};
                            const orderId = resData.orderId || 'ORD2026';

                            const walletRes = await axios.post(`${BACKEND_BASE}/api/bot/pay-via-wallet?orderId=${orderId}&phoneNumber=${senderPhone}`, null, { timeout: 30000 });
                            const wData = walletRes.data || {};
                            if (wData.success) {
                                const expiryDate = new Date(Date.now() + 10 * 60 * 1000);
                                const expiryTimeStr = expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
                                const userOtp = resData.otp || '';

                                const paidMsg = `✅ *Payment Successful via Wallet Balance!* 🎉\n` +
                                                `-----------------------------------\n` +
                                                `💰 *Amount Paid*: *₹${estimatedTotal.toFixed(2)}*\n` +
                                                `💳 *Remaining Wallet Balance*: *₹${(wData.newBalance || 0.0).toFixed(2)}*\n` +
                                                `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                                (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                                `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                                                `👉 *Whenever you are near the ${session.blockLocation || 'Campus Kiosk'} printer, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp* to release your print directly to the tray!`;

                                await sock.sendMessage(jid, { text: paidMsg });

                                session.lastOrderId = orderId;
                                session.lastOtp = userOtp;
                                session.lastPrice = estimatedTotal;
                                session.otpReleased = false;
                                session.paymentNotified = true;
                                session.paidTimestamp = Date.now();
                                session.lastReminderTimestamp = Date.now();
                                session.pending = null;
                                session.step = 'IDLE';
                                saveSessions(sessions);
                                return;
                            }
                        } catch (wErr) {
                            console.error("Quick Color wallet payment error:", wErr.message);
                        }
                    }

                    // 2. Razorpay payment link
                    await sock.sendMessage(jid, { text: "⏳ *Generating online payment link...*" });
                    try {
                        const remoteForm = createUploadFormData(session, senderName, senderPhone);
                        const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                        const response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
                        const resData = response.data || {};
                        const orderId = resData.orderId || 'ORD2026';
                        const paymentUrl = resData.paymentUrl || `${FRONTEND_BASE}/pay?orderId=${orderId}`;
                        const userOtp = resData.otp || '';

                        const payMsg = `💳 *Pay Online via Razorpay*:\n${paymentUrl}\n\n` +
                                     (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                     `⏳ *Payment Window*: *3 Minutes* (Order automatically cancels if unpaid within 3 minutes)\n\n` +
                                     `Tap the link above to complete your UPI/Card payment! Once paid, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp to print at *${session.blockLocation || 'your campus kiosk'}*!`;
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
                    } catch (remoteErr) {
                        console.error("Quick Color order creation failed:", remoteErr.message);
                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        await sock.sendMessage(jid, { text: "❌ *Transaction Failed*: Could not generate payment link right now. Please try again later." });
                        return;
                    }
                } else if (session.pending.isImage && (textLower.includes('custom') || textLower.includes('cop') || textLower === '3')) {
                    // Images have no page range or duplex mode: skip directly to Color selection
                    session.pending.selectedPages = 'ALL';
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
                } else if (!session.pending.isImage && (textLower.includes('custom') || textLower === '2')) {
                    if (session.pending.totalPages === 1) {
                        // 1-page PDF has no custom page range: skip to Print Sides selection
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
                } else {
                    if (session.pending.isImage) {
                        await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with:\n• *1* for Quick B&W Print (₹2)\n• *2* for Quick Color Print (₹5)\n• *3* to Customize Color & Copies` });
                    } else {
                        await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for Quick Print or *2* for Customize Print Settings.` });
                    }
                    return;
                }
            }

            if (session.step === 'SELECT_PAGE_OPTION') {
                if (textLower.includes('all') || textLower === '1') {
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
                    session.step = 'ENTER_CUSTOM_RANGE';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, { text: `🔢 *Enter Custom Page Range*:\n\nReply with your start and end page e.g. *"1-${session.pending.totalPages}"* or *"1,2"* (Total pages: ${session.pending.totalPages}):` });
                    return;
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for All Pages or *2* for Custom Page Range.` });
                    return;
                }
            }

            if (session.step === 'ENTER_CUSTOM_RANGE') {
                if (!isValidPageRange(rawText, session.pending.totalPages)) {
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Invalid Page Range ("${rawText}")!*\n\nTotal pages in file: *${session.pending.totalPages}*.\nPlease reply with a valid range between *1* and *${session.pending.totalPages}* e.g. *"1-${session.pending.totalPages}"* or *"1,2"*.`
                    });
                    return;
                }

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
                    await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for Single Sided or *2* for Both Sides / Duplex.` });
                    return;
                }
            }

            if (session.step === 'SELECT_COLOR') {
                if (textLower.includes('bw') || textLower.includes('black') || textLower.includes('b&w') || textLower.includes('b/w') || textLower === '1') {
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
                    session.pending.printType = 'COLOR';
                    session.pending.doubleSided = false;
                    session.step = 'ENTER_COPIES';
                    saveSessions(sessions);

                    await sock.sendMessage(jid, { text: `🔢 *Number of Copies*:\n\nReply with any number of copies you need (e.g. *1*, *2*, *5*, *10*, *25*, *50*, *100*, etc.):` });
                    return;
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with *1* for Black & White (₹2/pg) or *2* for Color (₹5/pg).` });
                    return;
                }
            }

            if (session.step === 'ENTER_COPIES') {
                const match = rawText.match(/\b\d+\b/) || rawText.match(/\d+/);
                const c = match ? parseInt(match[0], 10) : 0;
                if (c < 1) {
                    await sock.sendMessage(jid, { text: `⚠️ *Please reply with a valid number of copies* (e.g. *1*, *2*, *5*, *10*, *20*, *50*, etc.):` });
                    return;
                }
                session.pending.copies = c;
                await showOrderSummary(sock, jid, session, sessions, senderPhone);
                return;
            }

            if (session.step === 'CONFIRM_ORDER') {
                const printerCheck = await checkKioskPrinterStatus(session.blockLocation, session.pending?.printType || 'BW');
                if (!printerCheck.available) {
                    session.pending = null;
                    session.step = 'SELECT_BLOCK';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Kiosk Offline Alert*:\nYour selected kiosk (*${session.blockLocation}*) is currently offline, unassigned, or under maintenance.\n\n🚫 *Order cannot be placed for this block at this moment.*\n\nPlease choose an active online kiosk below to proceed with your print:`
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

                const userBal = session.pending?.userBalance || 0.0;
                const totalAmt = session.pending?.estimatedTotal || 0.0;
                const hasEnoughWallet = userBal >= totalAmt;

                const isWalletChoice = hasEnoughWallet && (textLower.includes('wallet') || textLower === '1');
                const isRazorpayChoice = (hasEnoughWallet && (textLower.includes('razorpay') || textLower.includes('online') || textLower === '2'))
                                         || (!hasEnoughWallet && (textLower.includes('confirm') || textLower.includes('yes') || textLower === 'y' || textLower === 'ok' || textLower === '1'));
                const isCancelChoice = (hasEnoughWallet && (textLower.includes('cancel') || textLower === '3'))
                                       || (!hasEnoughWallet && (textLower.includes('cancel') || textLower === '2'));

                if (isWalletChoice) {
                    await sock.sendMessage(jid, { text: "⏳ *Processing instant wallet payment... Waiting for server (up to 5 min)...*" });

                    let uploadRes;
                    try {
                        const remoteForm = createUploadFormData(session, senderName, senderPhone);
                        const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                        // 5-Minute timeout (300,000 ms)
                        uploadRes = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
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

                    const orderId = uploadRes.data?.orderId || 'ORD2026';

                    try {
                        const walletRes = await axios.post(`${BACKEND_BASE}/api/bot/pay-via-wallet?orderId=${orderId}&phoneNumber=${senderPhone}`, null, { timeout: 30000 });
                        const wData = walletRes.data || {};
                        if (wData.success) {
                            const expiryDate = new Date(Date.now() + 10 * 60 * 1000);
                            const expiryTimeStr = expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
                            const userOtp = uploadRes.data?.otp || '';

                            const paidMsg = `✅ *Payment Successful via Wallet Balance!* 🎉\n` +
                                            `-----------------------------------\n` +
                                            `💰 *Amount Paid*: *₹${totalAmt.toFixed(2)}*\n` +
                                            `💳 *Remaining Wallet Balance*: *₹${(wData.newBalance || 0.0).toFixed(2)}*\n` +
                                            `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                            (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                            `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                                            `👉 *Whenever you are near the ${session.blockLocation || 'Campus Kiosk'} printer, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp* to release your print directly to the tray!`;

                            await sock.sendMessage(jid, { text: paidMsg });

                            session.lastOrderId = orderId;
                            session.lastOtp = userOtp;
                            session.lastPrice = totalAmt;
                            session.otpReleased = false;
                            session.paymentNotified = true;
                            session.paidTimestamp = Date.now();
                            session.lastReminderTimestamp = Date.now();
                            session.pending = null;
                            session.step = 'IDLE';
                            saveSessions(sessions);
                            return;
                        } else {
                            await sock.sendMessage(jid, { text: `⚠️ *Wallet Payment Failed*: ${wData.message || 'Insufficient balance'}` });
                            return;
                        }
                    } catch (wErr) {
                        console.error("Wallet payment request error:", wErr.message);
                        await sock.sendMessage(jid, { text: "⚠️ *Wallet Payment Failed*. Please try paying online via Razorpay." });
                        return;
                    }
                } else if (isRazorpayChoice) {
                    await sock.sendMessage(jid, { text: "⏳ *Creating your order and payment link... Waiting for server (up to 5 min)...*" });

                    let response;
                    try {
                        const remoteForm = createUploadFormData(session, senderName, senderPhone);
                        const targetUrl = process.env.BACKEND_URL || 'https://printer-backend-kgzp.onrender.com/api/bot/direct-upload';
                        // 5-Minute timeout (300,000 ms)
                        response = await axios.post(targetUrl, remoteForm, { headers: remoteForm.getHeaders(), timeout: 300000 });
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
                                : (remoteErr.response?.data?.message || "❌ *Transaction Failed*: Could not generate payment link right now. Please try again later.");
                            await sock.sendMessage(jid, { text: errorMsg });
                        }
                        return;
                    }

                    const resData = response.data || {};
                    const orderId = resData.orderId || 'ORD2026';
                    const paymentUrl = resData.paymentUrl || `${FRONTEND_BASE}/pay?orderId=${orderId}`;
                    const userOtp = resData.otp || '';

                    let payMsg = `💳 *Pay Online via Razorpay*:\n${paymentUrl}\n\n` +
                                 (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                 `⏳ *Payment Window*: *3 Minutes* (Order automatically cancels if unpaid within 3 minutes)\n\n` +
                                 `Tap link above to complete payment online! Once paid, reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp to print at *${session.blockLocation || 'your campus kiosk'}*!`;
                    await sock.sendMessage(jid, { text: payMsg });

                    session.lastOrderId = orderId;
                    session.lastOtp = userOtp;
                    session.lastPrice = resData.estimatedTotal || session.pending.estimatedTotal;
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
                } else if (isCancelChoice) {
                    session.pending = null;
                    session.step = 'IDLE';
                    saveSessions(sessions);
                    await sock.sendMessage(jid, { text: "❌ Order draft cancelled. You can attach a new file to print anytime!" });
                    return;
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Invalid Choice ("${rawText}")!*\n\nPlease reply with a valid option number.` });
                    return;
                }
            }
        }

        // Friendly Chat AI Response
        const friendlyReply = getFriendlyChatResponse(textLower, rawText, senderName, session);
        await sock.sendMessage(jid, { text: friendlyReply });

    } catch (error) {
        console.error("FULL WhatsApp message error:", error);
    }
}

async function showOrderSummary(sock, jid, session, sessions, senderPhone) {
    const isImage = Boolean(session.pending.isImage);
    const pageCount = isImage ? 1 : countPagesFromRange(session.pending.selectedPages, session.pending.totalPages);
    const rate = session.pending.printType === 'COLOR' ? 5.0 : (session.pending.doubleSided ? 2.0 : 2.0);
    const div = session.pending.doubleSided ? 2.0 : 1.0;
    const paperSheets = Math.ceil(pageCount / div);
    const estimatedTotal = paperSheets * (session.pending.copies || 1) * rate;

    session.pending.estimatedTotal = estimatedTotal;

    let userBalance = 0.0;
    try {
        const balRes = await axios.get(`${BACKEND_BASE}/api/bot/user-balance?phoneNumber=${senderPhone}`, { timeout: 4000 });
        if (balRes.data && balRes.data.balance !== undefined) {
            userBalance = parseFloat(balRes.data.balance) || 0.0;
        }
    } catch (e) {}

    session.pending.userBalance = userBalance;
    session.step = 'CONFIRM_ORDER';
    saveSessions(sessions);

    const hasEnoughWallet = userBalance >= estimatedTotal;
    const menuOptions = hasEnoughWallet
        ? [
            `💳 Pay via Wallet Balance (Available: ₹${userBalance.toFixed(2)})`,
            '🌐 Pay Online via Razorpay Link',
            '❌ Cancel Order'
          ]
        : [
            '✅ Confirm & Pay (Get Razorpay Link)',
            '❌ Cancel Order'
          ];

    const summaryText = `*📋 Cloud Print Order Summary*\n\n` +
        `📄 File: *${session.pending.filename}*\n` +
        (isImage ? `🖼️ Type: *Photo / Image (1 Page)*\n` : `📊 Pages: *${pageCount}* (Range: ${session.pending.selectedPages})\n`) +
        (isImage ? `` : `📑 Sides: *${session.pending.doubleSided ? 'Both Sides (Duplex)' : 'Single Sided'}*\n`) +
        `🎨 Mode: *${session.pending.printType === 'COLOR' ? 'Color (₹5/pg)' : 'Black & White (₹2/pg)'}*\n` +
        `🔢 Copies: *${session.pending.copies || 1}*\n` +
        `📍 Kiosk: *${session.blockLocation}* (${session.college})\n` +
        `💰 Total Amount: *₹${estimatedTotal.toFixed(2)}*\n` +
        `💳 Wallet Balance: *₹${userBalance.toFixed(2)}*`;

    await sendSmartMenu(
        sock,
        jid,
        '📋 Cloud Print Order Summary',
        summaryText,
        'Select Payment Option',
        menuOptions
    );
}

function startOrderMonitoring() {
    // Check orders on-demand every 15s only for active sessions to conserve Render bandwidth
    setInterval(async () => {
        try {
            const sessions = loadSessions();
            let updated = false;
            const nowMs = Date.now();

            for (const phone of Object.keys(sessions)) {
                const session = sessions[phone];
                // Only monitor if session has an active, unnotified or pending order
                if (session.lastOrderId && sock && !session.notifiedCompletion) {
                    try {
                        const targetJid = session.jid || `${phone}@s.whatsapp.net`;

                        // 0. Auto-cancel Unpaid Orders after 3 Minutes (180,000 ms)
                        if (!session.paymentNotified && session.orderCreatedTimestamp) {
                            const unpaidElapsed = nowMs - session.orderCreatedTimestamp;
                            if (unpaidElapsed >= 180000) { // 3 minutes
                                try {
                                    await axios.post(`${BACKEND_BASE}/api/pdf/cancel`, null, {
                                        params: { orderId: session.lastOrderId }
                                    }).catch(() => {});
                                } catch (e) {}

                                const timeoutMsg = `❌ *Order ${session.lastOrderId} Cancelled (Payment Timeout)*\n\n` +
                                                   `Your print order was automatically cancelled because payment was not confirmed within 3 minutes.\n\n` +
                                                   `📄 *Need to print?* Simply attach and send your document again to create a new order anytime!`;

                                await sock.sendMessage(targetJid, { text: timeoutMsg });
                                session.lastOrderId = null;
                                session.lastOtp = null;
                                session.pending = null;
                                session.step = 'IDLE';
                                session.orderCreatedTimestamp = null;
                                updated = true;
                                continue;
                            }
                        }

                        const res = await axios.get(`${BACKEND_BASE}/api/pdf/details?orderId=${session.lastOrderId}`, { timeout: 5000 });
                        const data = res.data || {};

                        // 1. Post-Payment Confirmation Notice with Exact Expiry Time
                        if ((data.paymentStatus === 'PAID' || data.status === 'PAID' || data.status === 'CANCEL_WINDOW' || data.status === 'PENDING_SCAN') && !session.paymentNotified) {
                            const expiryDate = new Date(nowMs + 10 * 60 * 1000);
                            const expiryTimeStr = expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

                            const userOtp = data.otpCode || session.lastOtp || '';
                            const msgText = `✅ *Payment Confirmed for Order ${session.lastOrderId}!* 🎉\n\n` +
                                            `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                            (userOtp ? `🔐 *Your 4-Digit Release OTP*: *${userOtp}*\n` : '') +
                                            `⏳ *OTP Validity*: *10 Minutes* (Expires at *${expiryTimeStr}*)\n\n` +
                                            `👉 *Whenever you are near the ${session.blockLocation || 'Campus Kiosk'} printer, simply reply with your 4-digit OTP (*${userOtp}*) right here in WhatsApp* to release your print directly to the printer tray!`;

                            await sock.sendMessage(targetJid, { text: msgText });
                            session.paymentNotified = true;
                            if (userOtp) session.lastOtp = userOtp;
                            session.paidTimestamp = nowMs;
                            session.lastReminderTimestamp = nowMs;
                            updated = true;
                        }

                        // 2. Periodic 2-Minute Expiry Reminder
                        if ((data.status === 'PENDING_SCAN' || data.status === 'CANCEL_WINDOW' || data.status === 'PAID') && session.paymentNotified && !session.otpReleased) {
                            const lastReminder = session.lastReminderTimestamp || session.paidTimestamp || 0;
                            const timeSincePaid = nowMs - (session.paidTimestamp || nowMs);
                            const totalLimitMs = 10 * 60 * 1000;
                            const remainingMs = Math.max(0, totalLimitMs - timeSincePaid);
                            const minutesLeft = Math.ceil(remainingMs / 60000);
                            const userOtp = data.otpCode || session.lastOtp || '';

                            if (nowMs - lastReminder >= 120000 && minutesLeft > 0) {
                                const reminderText = `⏰ *REMINDER: Print Order Pending Release (${session.lastOrderId})!*\n\n` +
                                                     `📍 *Target Kiosk*: *${session.blockLocation || 'Campus Kiosk'}*\n` +
                                                     (userOtp ? `🔐 *Your OTP*: *${userOtp}*\n` : '') +
                                                     `⏳ *Time Remaining Before Expiry*: *${minutesLeft} minute(s)*\n\n` +
                                                     `👉 *Reply with your 4-digit OTP here in WhatsApp* to release your print at ${session.blockLocation || 'Campus Kiosk'} before time expires!`;

                                await sock.sendMessage(targetJid, { text: reminderText });
                                session.lastReminderTimestamp = nowMs;
                                updated = true;
                            }
                        }

                        // 3. Print Completed Notification & PDF Receipt
                        if (data.status === 'COMPLETED' && !session.notifiedCompletion) {
                            const priceVal = data.price || session.lastPrice || 0;
                            const priceFormatted = typeof priceVal === 'number' ? priceVal : (parseFloat(priceVal) || 0);

                            const pdfBuffer = await createReceiptPdf({
                                orderId: session.lastOrderId,
                                fileName: data.fileName || 'Document.pdf',
                                totalPages: data.totalPages || 1,
                                doubleSided: data.doubleSided || false,
                                printType: data.printType || 'BW',
                                copies: data.copies || 1,
                                price: priceFormatted,
                                blockLocation: session.blockLocation || 'Campus Kiosk'
                            });

                            await sock.sendMessage(targetJid, {
                                document: pdfBuffer,
                                mimetype: 'application/pdf',
                                fileName: `Print_Receipt_${session.lastOrderId}.pdf`,
                                caption: `🧾 *Official Print Receipt for Order ${session.lastOrderId}*\n\n🎉 *Print Job Complete!* Please collect your printed document from the printer tray right now. Thank you for using Cloud Print!`
                            });

                            session.lastOrderId = null;
                            session.lastOtp = null;
                            session.notifiedCompletion = true;
                            updated = true;
                        }

                        // 4. Timeout Expiry / Cancellation Notification with 7-Day Refund Coupon
                        if ((data.status === 'CANCELLED' || data.status === 'EXPIRED') && !session.notifiedCancelled && !session.notifiedCompletion && !session.otpReleased) {
                            const refundVal = data.price || session.lastPrice || 2.0;
                            const refundNum = typeof refundVal === 'number' ? refundVal : (parseFloat(refundVal) || 2.0);
                            const couponCode = await generateRefundCoupon(refundNum);

                            const msgText = `⏰ *Order ${session.lastOrderId} Expired / Cancelled*\n\n` +
                                            `The release OTP was not entered within the time limit.\n\n` +
                                            `🎟️ *PRINT REFUND COUPON GENERATED*:\n` +
                                            `-----------------------------------------\n` +
                                            `💰 *Refund Value*: *₹${refundNum.toFixed(2)}*\n` +
                                            `🏷️ *Coupon Code*: *${couponCode}*\n` +
                                            `⏰ *Validity*: *7 Days* (Single Use Only)\n` +
                                            `-----------------------------------------\n` +
                                            `💡 *How to Redeem*:\n` +
                                            `1. Reply *"${couponCode}"* or *"COUPON ${couponCode}"* right here on WhatsApp to add ₹${refundNum.toFixed(2)} to your wallet balance instantly!\n` +
                                            `2. Or enter code *${couponCode}* on the checkout page of your next order.`;

                            await sock.sendMessage(targetJid, { text: msgText });
                            session.lastOrderId = null;
                            session.lastOtp = null;
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

            if (updated) saveSessions(sessions);
        } catch (e) {}
    }, 5000);
}

startBot();
