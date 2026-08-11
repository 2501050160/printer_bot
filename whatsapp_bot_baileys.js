/**
 * Cloud Print Kiosk - Native Baileys WhatsApp Bot Agent
 * -----------------------------------------------------
 * Interactive WhatsApp Bot Flow:
 * - College / Shop selection & permanent locking per user
 * - Online Campus Block selection & switching
 * - Document upload, Page Range (ALL vs Custom), Print Type (BW vs Color)
 * - Order estimate summary & confirmation
 * - Separate OTP and Payment Link messages
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    generateWAMessageFromContent,
    getAggregateVotesInPollMessage,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const BACKEND_URL = process.env.BACKEND_URL || 'https://printer-backend-1.onrender.com/api/bot/direct-upload';
const SESSIONS_FILE = path.join(__dirname, 'user_sessions.json');

console.log('🤖 Initializing Cloud Print Interactive WhatsApp Bot Agent...');

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
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    } catch (e) {
        console.error('Failed to save user_sessions.json:', e);
    }
}

async function getCollegesAndBlocks() {
    try {
        const res = await axios.get('https://printer-backend-1.onrender.com/api/blocks/all', { timeout: 10000 });
        const data = res.data || [];
        const map = {};
        data.forEach(b => {
            const rawCol = b.college || b.collegeName || '';
            let college = (rawCol && rawCol.trim() && rawCol !== 'General Campus') ? rawCol.trim() : 'KLU';
            const blockName = b.name || b.blockName || '';
            if (blockName && blockName.toLowerCase().includes('lakshmi')) {
                college = 'Lakshmi Narayana Xerox';
            }
            if (!map[college]) map[college] = [];
            if (blockName) map[college].push(blockName);
        });
        if (!map['KLU'] || map['KLU'].length === 0) {
            map['KLU'] = ['R Block', 'C Block', 'L Block'];
        }
        if (!map['Lakshmi Narayana Xerox']) {
            map['Lakshmi Narayana Xerox'] = ['Shop Main Desk'];
        }
        return map;
    } catch (e) {
        return {
            'KLU': ['R Block', 'C Block', 'L Block'],
            'Lakshmi Narayana Xerox': ['Shop Main Desk']
        };
    }
}

async function countPdfPages(buffer) {
    let totalPages = 1;
    try {
        const str = buffer.toString('binary');
        const matches = str.match(/\/Type\s*\/Page\b/g);
        if (matches && matches.length > 0) {
            totalPages = matches.length;
        }
        const countMatch = str.match(/\/Count\s+(\d+)/);
        if (countMatch && parseInt(countMatch[1], 10) > 0) {
            totalPages = Math.max(totalPages, parseInt(countMatch[1], 10));
        }
    } catch (e) {}
    return totalPages;
}

function countPagesFromRange(rangeStr, totalPages) {
    if (!rangeStr) return totalPages;
    const str = rangeStr.trim().toLowerCase();
    if (str === 'all' || str === '1') return totalPages;

    try {
        if (rangeStr.includes('-')) {
            const parts = rangeStr.split('-').map(s => parseInt(s.trim(), 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                const count = Math.abs(parts[1] - parts[0]) + 1;
                return Math.min(count, totalPages);
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

const processedMsgIds = new Set();

async function sendInteractiveButtons(sock, from, title, bodyText, footerText, buttonList, senderPhone) {
    try {
        let fullMsgText = title ? `*${title}*\n\n${bodyText}` : bodyText;

        if (buttonList && buttonList.length > 0) {
            fullMsgText += '\n\n-----------------------------------\n';
            const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            buttonList.forEach((btn, idx) => {
                const prefix = numEmojis[idx] || `${idx + 1}️⃣`;
                fullMsgText += `${prefix} *${btn.text}*\n`;
            });
            fullMsgText += '\n👉 *Reply with the option number (e.g. 1, 2, 3)!*';
        }

        await sock.sendMessage(from, { text: fullMsgText });
    } catch (e) {
        console.error('Send error:', e.message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 FRESH QR CODE GENERATED! SCAN WITH WHATSAPP LINKED DEVICES.\n');
            try {
                const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
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
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = (statusCode === DisconnectReason.loggedOut);
            console.log(`Connection closed (statusCode: ${statusCode}). Logged out: ${loggedOut}`);
            if (loggedOut) {
                console.log('Session logged out. Clearing session and regenerating QR code...');
                try {
                    fs.rmSync(path.join(__dirname, 'baileys_auth_info'), { recursive: true, force: true });
                } catch (e) {}
            }
            setTimeout(startBot, 2000);
        } else if (connection === 'open') {
            console.log('✅ Interactive Menu WhatsApp Print Bot is connected and ready!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type !== 'notify') return;

            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;

            if (processedMsgIds.has(msg.key.id)) return;
            processedMsgIds.add(msg.key.id);
            if (processedMsgIds.size > 500) processedMsgIds.clear();

            const from = msg.key.remoteJid;
            const pushName = msg.pushName || 'Student';
            const senderPhone = from.replace(/@.*/, '');

            // Ignore status broadcasts
            if (from === 'status@broadcast') return;

            const isDocument = !!(msg.message.documentMessage || msg.message.imageMessage);
            const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            if (!rawText && !isDocument) return;

            console.log(`📩 Incoming message from ${senderPhone} (${pushName}): "${rawText}" | isDoc: ${isDocument}`);

            const textLower = rawText.toLowerCase();

            const sessions = loadSessions();
            if (!sessions[senderPhone]) {
                sessions[senderPhone] = {
                    phoneNumber: senderPhone,
                    name: pushName,
                    college: null, // Fixed once selected
                    blockLocation: null, // Selected block
                    step: 'IDLE',
                    pending: null
                };
            }
            const session = sessions[senderPhone];
            const collegesMap = await getCollegesAndBlocks();
            const collegeList = Object.keys(collegesMap);

            // Command: Check / Change Block
            if (textLower === 'block' || textLower === '/block' || textLower === 'change block' || rawText === 'btn_change_block') {
                if (!session.college) {
                    await sock.sendMessage(from, { text: "⚠️ Please select your College/Shop first by sending 'Hi'." });
                    return;
                }
                const blocks = collegesMap[session.college] || [];
                const blockButtons = blocks.map(b => ({
                    id: `blk_${b}`,
                    text: `📍 ${b}`
                }));
                session.step = 'SELECT_BLOCK';
                saveSessions(sessions);

                await sendInteractiveButtons(
                    sock,
                    from,
                    `📍 Available Kiosk Blocks in ${session.college}`,
                    'Tap a button below to set your active print kiosk:',
                    'Select Active Block',
                    blockButtons,
                    senderPhone
                );
                return;
            }

            // -------------------------------------------------------------
            // UNIVERSAL COMMAND: QUIT / CANCEL (Works at ANY step)
            // -------------------------------------------------------------
            if (textLower === 'quit' || textLower === '/quit' || textLower === 'cancel' || textLower === '/cancel' || textLower === 'exit' || textLower === 'q') {
                session.pending = null;
                session.step = 'IDLE';
                saveSessions(sessions);
                await sock.sendMessage(from, { 
                    text: `❌ *Session Cancelled*.\n\nYou have exited the current order process. You can attach a new PDF document/image or type 'Hi' anytime to start again!` 
                });
                return;
            }

            // -------------------------------------------------------------
            // UNIVERSAL COMMAND: GO BACK TO BLOCK SELECTION (Works at ANY step)
            // -------------------------------------------------------------
            if (textLower === '3' || textLower === 'block' || textLower === '/block' || textLower === 'change block' || textLower === 'b' || textLower.includes('change block') || rawText === 'btn_change_block' || rawText === 'opt_3') {
                if (!session.college) {
                    await sock.sendMessage(from, { text: "⚠️ Please select your College/Shop first by sending 'Hi'." });
                    return;
                }
                const blocks = collegesMap[session.college] || [];
                const blockButtons = blocks.map(b => ({
                    id: `blk_${b}`,
                    text: `📍 ${b}`
                }));
                session.pending = null; // Clear pending file if changing kiosk
                session.step = 'SELECT_BLOCK';
                saveSessions(sessions);

                await sendInteractiveButtons(
                    sock,
                    from,
                    `📍 Available Kiosk Blocks in ${session.college}`,
                    `Please select an active kiosk block below:\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                    'Select Active Block',
                    blockButtons,
                    senderPhone
                );
                return;
            }

            // Command: Attempting to change College
            if (textLower.includes('change college') || textLower.includes('reset college')) {
                if (session.college) {
                    await sock.sendMessage(from, { 
                        text: `⚠️ *College Fixed*: Your account is permanently registered under *${session.college}*.\n\nYou can switch your active kiosk block anytime by replying *"block"*!` 
                    });
                    return;
                }
            }

            // -------------------------------------------------------------
            // STEP 3: DOCUMENT UPLOAD (HIGHEST PRIORITY WHEN ATTACHED)
            // -------------------------------------------------------------
            if (isDocument) {
                await sock.sendMessage(from, { text: "⏳ *Downloading and analyzing your document... Please wait.*" });

                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );

                if (!buffer || buffer.length === 0) {
                    await sock.sendMessage(from, { text: "⚠️ Empty or unreadable file. Please try sending again." });
                    return;
                }

                const docMsg = msg.message.documentMessage;
                const imgMsg = msg.message.imageMessage;
                const mimetype = (docMsg && docMsg.mimetype) || (imgMsg && imgMsg.mimetype) || 'application/pdf';
                const filename = (docMsg && docMsg.fileName) || (mimetype.includes('pdf') ? 'document.pdf' : 'image.jpg');
                const totalPages = mimetype.includes('pdf') ? (await countPdfPages(buffer)) : 1;

                session.pending = {
                    filename,
                    mimetype,
                    bufferBase64: buffer.toString('base64'),
                    totalPages,
                    selectedPages: 'ALL',
                    printType: 'BW',
                    copies: 1
                };
                session.step = 'SELECT_PAGE_OPTION';
                saveSessions(sessions);

                await sendInteractiveButtons(
                    sock,
                    from,
                    `📄 Document Received: ${filename}`,
                    `📊 Total Pages Detected: *${totalPages}*\n📍 Kiosk: *${session.blockLocation}* (${session.college})\n\nPlease select page printing option:\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                    'Select Page Option',
                    [
                        { id: 'page_ALL', text: `📄 All Pages (1-${totalPages})` },
                        { id: 'page_CUSTOM', text: '🔢 Custom Page Range' }
                    ],
                    senderPhone
                );
                return;
            }

            // -------------------------------------------------------------
            // HANDLE PENDING DOCUMENT ORDER STEPS (Takes Priority Over Menu Numbers)
            // -------------------------------------------------------------
            if (session.pending) {
                // Step: Page Selection Choice (All vs Custom)
                if (session.step === 'SELECT_PAGE_OPTION') {
                    if (rawText === 'page_ALL' || rawText === '1' || textLower.includes('all')) {
                        session.pending.selectedPages = 'ALL';
                        session.step = 'SELECT_PRINT_TYPE';
                        saveSessions(sessions);

                        await sendInteractiveButtons(
                            sock,
                            from,
                            '🎨 Select Print Color Mode',
                            `Please choose your print color mode below:\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                            'Select Color Mode',
                            [
                                { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                                { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                            ],
                            senderPhone
                        );
                        return;
                    } else if (rawText === 'page_CUSTOM' || rawText === '2' || textLower.includes('custom')) {
                        session.step = 'ENTER_START_PAGE';
                        saveSessions(sessions);
                        await sock.sendMessage(from, { 
                            text: `▶️ *Step 1 of 2: Enter Start Page*\n\nPlease reply with a valid **START page number** (between **1** and **${session.pending.totalPages}**):\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*` 
                        });
                        return;
                    } else {
                        // Helpful Validation Error Prompt
                        await sendInteractiveButtons(
                            sock,
                            from,
                            `⚠️ Invalid Option Choice`,
                            `Please reply with a valid option number below:\n\n1️⃣ *📄 All Pages (1-${session.pending.totalPages})*\n2️⃣ *🔢 Custom Page Range*\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                            'Select Page Option',
                            [
                                { id: 'page_ALL', text: `📄 All Pages (1-${session.pending.totalPages})` },
                                { id: 'page_CUSTOM', text: '🔢 Custom Page Range' }
                            ],
                            senderPhone
                        );
                        return;
                    }
                }

                // Step: Custom Page Range - Start Page Entry
                if (session.step === 'ENTER_START_PAGE') {
                    if (rawText.includes('-')) {
                        session.pending.selectedPages = rawText;
                        session.step = 'SELECT_PRINT_TYPE';
                        saveSessions(sessions);

                        await sendInteractiveButtons(
                            sock,
                            from,
                            `✅ Page Range Set: ${rawText}`,
                            `Now please select your print color mode below:\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                            'Select Color Mode',
                            [
                                { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                                { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                            ],
                            senderPhone
                        );
                        return;
                    }

                    const startPg = parseInt(rawText, 10);
                    if (isNaN(startPg) || startPg < 1 || startPg > session.pending.totalPages) {
                        await sock.sendMessage(from, { 
                            text: `⚠️ *Invalid Start Page*!\n\nDocument *${session.pending.filename}* has **${session.pending.totalPages} total pages**.\n\n👉 Please reply with a valid START page number between **1** and **${session.pending.totalPages}** (e.g. 1):\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*` 
                        });
                        return;
                    }

                    session.pending.startPage = startPg;
                    session.step = 'ENTER_END_PAGE';
                    saveSessions(sessions);

                    await sock.sendMessage(from, { 
                        text: `⏹️ *Step 2 of 2: Enter End Page*\n\nStart page is set to **${startPg}**.\nPlease reply with a valid **END page number** between **${startPg}** and **${session.pending.totalPages}** (e.g. ${session.pending.totalPages}):\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*` 
                    });
                    return;
                }

                // Step: Custom Page Range - End Page Entry
                if (session.step === 'ENTER_END_PAGE') {
                    const endPg = parseInt(rawText, 10);
                    const startPg = session.pending.startPage || 1;
                    if (isNaN(endPg) || endPg < startPg || endPg > session.pending.totalPages) {
                        await sock.sendMessage(from, { 
                            text: `⚠️ *Invalid End Page*!\n\nStart page is set to **${startPg}** (Total pages: **${session.pending.totalPages}**).\n\n👉 Please reply with a valid END page number between **${startPg}** and **${session.pending.totalPages}** (e.g. ${session.pending.totalPages}):\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*` 
                        });
                        return;
                    }

                    const rangeStr = `${startPg}-${endPg}`;
                    session.pending.selectedPages = rangeStr;
                    session.step = 'SELECT_PRINT_TYPE';
                    saveSessions(sessions);

                    await sendInteractiveButtons(
                        sock,
                        from,
                        `✅ Custom Range Set: Pages ${rangeStr}`,
                        `Now please select your print color mode below:\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                        'Select Color Mode',
                        [
                            { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                            { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                        ],
                        senderPhone
                    );
                    return;
                }

                // Step: Print Type Choice
                if (session.step === 'SELECT_PRINT_TYPE') {
                    if (rawText === 'mode_BW' || rawText === '1' || textLower.includes('bw') || textLower.includes('black')) {
                        session.pending.printType = 'BW';
                    } else if (rawText === 'mode_COLOR' || rawText === '2' || textLower.includes('color') || textLower.includes('colour')) {
                        session.pending.printType = 'COLOR';
                    } else {
                        // Helpful Validation Error Prompt
                        await sendInteractiveButtons(
                            sock,
                            from,
                            '⚠️ Invalid Color Selection',
                            `Please reply with a valid option number below:\n\n1️⃣ *⚫ Black & White (₹2/pg)*\n2️⃣ *🎨 Color (₹5/pg)*\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                            'Select Color Mode',
                            [
                                { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                                { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                            ],
                            senderPhone
                        );
                        return;
                    }

                    const pageCount = countPagesFromRange(session.pending.selectedPages, session.pending.totalPages);
                    const rate = session.pending.printType === 'COLOR' ? 5.0 : 2.0;
                    const estimatedTotal = pageCount * session.pending.copies * rate;

                    session.pending.estimatedTotal = estimatedTotal;
                    session.step = 'CONFIRM_ORDER';
                    saveSessions(sessions);

                    await sendInteractiveButtons(
                        sock,
                        from,
                        '📋 Cloud Print Order Summary',
                        `📄 File: *${session.pending.filename}*\n📊 Pages: *${pageCount}* (Range: ${session.pending.selectedPages})\n🎨 Mode: *${session.pending.printType === 'COLOR' ? 'Color (₹5/pg)' : 'Black & White (₹2/pg)'}*\n📍 Kiosk: *${session.blockLocation}* (${session.college})\n💰 Total Estimate: *₹${estimatedTotal.toFixed(2)}*\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                        'Confirm Order',
                        [
                            { id: 'confirm_YES', text: '✅ Confirm Order (YES)' },
                            { id: 'confirm_NO', text: '❌ Cancel Order (NO)' }
                        ],
                        senderPhone
                    );
                    return;
                }

                // Step: Confirming Order (YES / NO)
                if (session.step === 'CONFIRM_ORDER') {
                    if (rawText === 'confirm_YES' || rawText === '1' || textLower === 'yes' || textLower === 'y' || textLower === 'ok') {
                        await sock.sendMessage(from, { text: "⏳ *Creating your order and payment link... Please wait.*" });

                        const buffer = Buffer.from(session.pending.bufferBase64, 'base64');
                        const form = new FormData();
                        form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype });
                        form.append('customerName', `${pushName} (${senderPhone})`);
                        form.append('phoneNumber', senderPhone);
                        form.append('blockLocation', session.blockLocation);
                        form.append('printType', session.pending.printType);

                        let response;
                        try {
                            response = await axios.post(BACKEND_URL, form, { headers: form.getHeaders(), timeout: 30000 });
                        } catch (primaryErr) {
                            const fallbackUrl = 'https://printer-backend-1.onrender.com/api/bot/direct-upload';
                            form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype });
                            response = await axios.post(fallbackUrl, form, { headers: form.getHeaders(), timeout: 30000 });
                        }

                        const resData = response.data || {};
                        const otp = resData.otp || '0001';
                        const orderId = resData.orderId || 'ORD2026';
                        const paymentUrl = resData.paymentUrl || `https://printe-frontend.onrender.com/checkout?orderId=${orderId}`;

                        // Message 1: Order Details & 4-Digit Release OTP
                        let otpMsg = `🖨️ *Cloud Print Order Created!*\n` +
                                     `-----------------------------------\n` +
                                     `📄 *File*: ${session.pending.filename}\n` +
                                     `📊 *Pages*: ${resData.totalPages || 1} | *Type*: ${session.pending.printType}\n` +
                                     `💰 *Total Amount*: ₹${(resData.estimatedTotal || session.pending.estimatedTotal).toFixed(2)}\n` +
                                     `🔐 *Your 4-Digit Release OTP*: *${otp}*\n` +
                                     `📍 *Target Kiosk*: ${session.blockLocation}`;

                        await sock.sendMessage(from, { text: otpMsg });

                        // Message 2: Separate Payment Link
                        let payMsg = `👉 *Click here to complete payment*:\n${paymentUrl}`;
                        await sock.sendMessage(from, { text: payMsg });

                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        return;
                    } else if (rawText === 'confirm_NO' || rawText === '2' || textLower === 'no' || textLower === 'n' || textLower === 'cancel') {
                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        await sock.sendMessage(from, { text: "❌ Order cancelled. You can attach a new file to print anytime!" });
                        return;
                    } else {
                        // Helpful Validation Error Prompt
                        await sendInteractiveButtons(
                            sock,
                            from,
                            '⚠️ Invalid Choice',
                            `Please reply with a valid option number below:\n\n1️⃣ *✅ Confirm Order (YES)*\n2️⃣ *❌ Cancel Order (NO)*\n\n📍 *Reply 'block' to change kiosk* | ❌ *Reply 'quit' to cancel*`,
                            'Confirm Order',
                            [
                                { id: 'confirm_YES', text: '✅ Confirm Order (YES)' },
                                { id: 'confirm_NO', text: '❌ Cancel Order (NO)' }
                            ],
                            senderPhone
                        );
                        return;
                    }
                }
            }

            // -------------------------------------------------------------
            // MENU COMMAND ROUTER (IDLE STATE ONLY)
            // -------------------------------------------------------------
            if (!session.pending && session.step === 'IDLE') {
                if (textLower === '1' || textLower === 'opt_1' || textLower.includes('upload')) {
                    await sock.sendMessage(from, {
                        text: `📤 *Upload Your Document*\n-----------------------------------\n📍 Active Kiosk: *${session.blockLocation || 'R Block'}* (${session.college || 'KLU'})\n\n👉 *Please attach and send your PDF document or Image file now!*`
                    });
                    return;
                }

                if (textLower === '2' || textLower.includes('price') || textLower.includes('cost') || textLower.includes('rate')) {
                    await sendInteractiveButtons(
                        sock,
                        from,
                        '💰 Cloud Print Tariff Schedule',
                        'Transparent, fixed printing rates across all campus kiosks:\n\n• *Black & White*: ₹2.00 / page\n• *Full Color*: ₹5.00 / page\n• *Double-sided*: 10% Discount applied automatically!',
                        'Cloud Print Rates',
                        [
                            { id: 'opt_1', text: '📤 Upload Document' },
                            { id: 'opt_5', text: '🏢 Locate Print Shop' }
                        ],
                        senderPhone
                    );
                    return;
                }

                if (textLower === '3' || textLower.includes('track') || textLower.includes('otp') || textLower.includes('status')) {
                    const pendingOtp = session.pending ? session.pending.otp : '0001';
                    await sendInteractiveButtons(
                        sock,
                        from,
                        '📦 Active Order Tracker',
                        `📍 *Active Kiosk*: ${session.blockLocation || 'KLU - R Block Kiosk'}\n🔐 *Release OTP*: *${pendingOtp}*\n⚡ *Status*: Ready for Pickup at Kiosk!\n\nWalk up to the kiosk touchscreen, enter your OTP, and your pages will print immediately!`,
                        'Order Status',
                        [
                            { id: 'opt_1', text: '📤 Upload Document' },
                            { id: 'opt_5', text: '🏢 Locate Print Shop' }
                        ],
                        senderPhone
                    );
                    return;
                }

                if (textLower === '4' || textLower.includes('history') || textLower.includes('past')) {
                    await sendInteractiveButtons(
                        sock,
                        from,
                        '🖨️ Print History',
                        'Your recent cloud print transactions:\n-----------------------------------\n1. *Assignment_Final.pdf* • 4 pgs • ₹8.00\n   ✅ Released at R Block (OTP: 8492)\n\n2. *Project_Diagram.png* • Color • ₹5.00\n   ✅ Released at C Block (OTP: 3104)',
                        'Print History',
                        [
                            { id: 'opt_1', text: '📤 Upload Document' },
                            { id: 'opt_menu', text: '🏠 Main Menu' }
                        ],
                        senderPhone
                    );
                    return;
                }

                if (textLower === '5' || textLower.includes('locate') || textLower.includes('shop') || textLower.includes('where')) {
                    const blocksMap = await getCollegesAndBlocks();
                    let locText = '🏢 *Live Campus Kiosk Locations & Status*\n-----------------------------------\n';
                    Object.keys(blocksMap).forEach(col => {
                        locText += `*${col}*:\n`;
                        blocksMap[col].forEach(blk => {
                            locText += `  • 📍 *${blk}* (Online • 0 min wait)\n`;
                        });
                    });
                    await sendInteractiveButtons(
                        sock,
                        from,
                        '🏢 Campus Kiosk Locations',
                        locText,
                        'Select Kiosk Block',
                        [{ id: 'btn_change_block', text: '🔄 Change Kiosk Block' }],
                        senderPhone
                    );
                    return;
                }

                if (textLower === '6' || textLower.includes('support') || textLower.includes('contact') || textLower.includes('help')) {
                    await sock.sendMessage(from, {
                        text: `☎ *Cloud Print Customer Support*\n-----------------------------------\nNeed help with paper jams, payment refunds, or kiosk access?\n\n• 💬 *WhatsApp Support*: Available on Campus Desk\n• 📧 *Email*: support@cloudprint.edu\n• ⏰ *Hours*: 8:00 AM - 10:00 PM (Mon - Sat)\n\nOur campus tech team responds within 2 minutes!`
                    });
                    return;
                }
            }

            // -------------------------------------------------------------
            // STEP 1: NEW USER - COLLEGE SELECTION (Buttons)
            // -------------------------------------------------------------
            if (!session.college) {
                let chosenCollege = null;
                if (rawText.startsWith('col_')) {
                    chosenCollege = rawText.replace('col_', '');
                } else {
                    const found = collegeList.find(c => textLower.includes(c.toLowerCase()) || rawText.toLowerCase().includes(c.toLowerCase()));
                    if (found) {
                        chosenCollege = found;
                    } else {
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
                    const blockButtons = blocks.map(b => ({
                        id: `blk_${b}`,
                        text: `📍 ${b}`
                    }));

                    let blkText = `Now select an available Kiosk Block in *${chosenCollege}* below:`;

                    await sendInteractiveButtons(
                        sock,
                        from,
                        `✅ College Fixed: ${chosenCollege}`,
                        blkText,
                        'Select Kiosk Block',
                        blockButtons,
                        senderPhone
                    );
                    return;
                } else {
                    session.step = 'SELECT_COLLEGE';
                    saveSessions(sessions);

                    const colButtons = collegeList.map(col => ({
                        id: `col_${col}`,
                        text: `🏫 ${col}`
                    }));

                    let colText = 'Fast, secure, and hassle-free document printing.\n\nHow can we help you today?\n\nPlease select your *College / Print Shop* below:\n*(Note: Your selected College/Shop will be fixed for your number)*';

                    await sendInteractiveButtons(
                        sock,
                        from,
                        '👋 Hello! Welcome to Cloud Print.',
                        colText,
                        'Select College / Print Shop',
                        colButtons,
                        senderPhone
                    );
                    return;
                }
            }

            // -------------------------------------------------------------
            // STEP 2: BLOCK SELECTION (Buttons)
            // -------------------------------------------------------------
            if (session.step === 'SELECT_BLOCK' || !session.blockLocation) {
                const blocks = collegesMap[session.college] || [];
                let chosenBlock = null;

                if (rawText.startsWith('blk_')) {
                    chosenBlock = rawText.replace('blk_', '');
                } else {
                    const found = blocks.find(b => textLower.includes(b.toLowerCase()) || rawText.toLowerCase().includes(b.toLowerCase()));
                    if (found) {
                        chosenBlock = found;
                    } else {
                        const num = parseInt(rawText, 10);
                        if (!isNaN(num) && num >= 1 && num <= blocks.length) {
                            chosenBlock = blocks[num - 1];
                        }
                    }
                }

                if (chosenBlock && blocks.includes(chosenBlock)) {
                    session.blockLocation = chosenBlock;
                    session.step = 'IDLE';
                    saveSessions(sessions);

                    await sendInteractiveButtons(
                        sock,
                        from,
                        `✅ Active Kiosk Set: ${chosenBlock}`,
                        `Campus: *${session.college}*\n\n🖨️ Simply attach and send your **PDF file or Image** to start your print order!`,
                        'Ready to Print',
                        [{ id: 'btn_change_block', text: '🔄 Change Kiosk Block' }],
                        senderPhone
                    );
                    return;
                } else {
                    session.step = 'SELECT_BLOCK';
                    saveSessions(sessions);

                    const blockButtons = blocks.map(b => ({
                        id: `blk_${b}`,
                        text: `📍 ${b}`
                    }));

                    let blkText = 'Please select an online kiosk block below:';

                    await sendInteractiveButtons(
                        sock,
                        from,
                        `📍 Kiosk Selection (${session.college})`,
                        blkText,
                        'Select Kiosk Block',
                        blockButtons,
                        senderPhone
                    );
                    return;
                }
            }

            // -------------------------------------------------------------
            // STEP 3: DOCUMENT UPLOAD & INTERACTIVE OPTION BUTTONS
            // -------------------------------------------------------------
            if (isDocument) {
                await sock.sendMessage(from, { text: "⏳ *Downloading and analyzing your document... Please wait.*" });

                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );

                if (!buffer || buffer.length === 0) {
                    await sock.sendMessage(from, { text: "⚠️ Empty or unreadable file. Please try sending again." });
                    return;
                }

                const docMsg = msg.message.documentMessage;
                const imgMsg = msg.message.imageMessage;
                const mimetype = (docMsg && docMsg.mimetype) || (imgMsg && imgMsg.mimetype) || 'application/pdf';
                const filename = (docMsg && docMsg.fileName) || (mimetype.includes('pdf') ? 'document.pdf' : 'image.jpg');
                const totalPages = mimetype.includes('pdf') ? (await countPdfPages(buffer)) : 1;

                session.pending = {
                    filename,
                    mimetype,
                    bufferBase64: buffer.toString('base64'),
                    totalPages,
                    selectedPages: 'ALL',
                    printType: 'BW',
                    copies: 1
                };
                session.step = 'SELECT_PAGE_OPTION';
                saveSessions(sessions);

                await sendInteractiveButtons(
                    sock,
                    from,
                    `📄 Document Received: ${filename}`,
                    `📊 Total Pages Detected: *${totalPages}*\n📍 Kiosk: *${session.blockLocation}* (${session.college})\n\nPlease select page printing option:`,
                    'Select Page Option',
                    [
                        { id: 'page_ALL', text: `📄 All Pages (1-${totalPages})` },
                        { id: 'page_CUSTOM', text: '🔢 Custom Page Range' }
                    ]
                );
                return;
            }

            // Handle Conversation Steps when Pending File Exists
            if (session.pending) {
                // Step: Page Selection Choice
                if (session.step === 'SELECT_PAGE_OPTION') {
                    if (rawText === 'page_ALL' || rawText === '1' || textLower.includes('all')) {
                        session.pending.selectedPages = 'ALL';
                        session.step = 'SELECT_PRINT_TYPE';
                        saveSessions(sessions);

                        await sendInteractiveButtons(
                            sock,
                            from,
                            '🎨 Select Print Color Mode',
                            'Please choose your print color mode below:',
                            'Select Color Mode',
                            [
                                { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                                { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                            ]
                        );
                        return;
                    } else if (rawText === 'page_CUSTOM' || rawText === '2' || textLower.includes('custom')) {
                        session.step = 'ENTER_CUSTOM_RANGE';
                        saveSessions(sessions);
                        await sock.sendMessage(from, { 
                            text: `🔢 *Enter Custom Page Range*:\n\nReply with range e.g. *"1-5"* or *"1,2,4"* (Total pages: ${session.pending.totalPages}):` 
                        });
                        return;
                    }
                }

                // Step: Custom Page Range Entry
                if (session.step === 'ENTER_CUSTOM_RANGE') {
                    session.pending.selectedPages = rawText;
                    session.step = 'SELECT_PRINT_TYPE';
                    saveSessions(sessions);

                    await sendInteractiveButtons(
                        sock,
                        from,
                        `✅ Range Set: ${rawText}`,
                        'Now please select your print color mode below:',
                        'Select Color Mode',
                        [
                            { id: 'mode_BW', text: '⚫ Black & White (₹2/pg)' },
                            { id: 'mode_COLOR', text: '🎨 Color (₹5/pg)' }
                        ]
                    );
                    return;
                }

                // Step: Print Type Choice
                if (session.step === 'SELECT_PRINT_TYPE') {
                    if (rawText === 'mode_BW' || rawText === '1' || textLower.includes('bw') || textLower.includes('black')) {
                        session.pending.printType = 'BW';
                    } else if (rawText === 'mode_COLOR' || rawText === '2' || textLower.includes('color') || textLower.includes('colour')) {
                        session.pending.printType = 'COLOR';
                    }

                    const pageCount = countPagesFromRange(session.pending.selectedPages, session.pending.totalPages);
                    const rate = session.pending.printType === 'COLOR' ? 5.0 : 2.0;
                    const estimatedTotal = pageCount * session.pending.copies * rate;

                    session.pending.estimatedTotal = estimatedTotal;
                    session.step = 'CONFIRM_ORDER';
                    saveSessions(sessions);

                    await sendInteractiveButtons(
                        sock,
                        from,
                        '📋 Cloud Print Order Summary',
                        `📄 File: *${session.pending.filename}*\n📊 Pages: *${pageCount}* (Range: ${session.pending.selectedPages})\n🎨 Mode: *${session.pending.printType === 'COLOR' ? 'Color (₹5/pg)' : 'Black & White (₹2/pg)'}*\n📍 Kiosk: *${session.blockLocation}* (${session.college})\n💰 Total Estimate: *₹${estimatedTotal.toFixed(2)}*`,
                        'Confirm Order',
                        [
                            { id: 'confirm_YES', text: '✅ Confirm Order (YES)' },
                            { id: 'confirm_NO', text: '❌ Cancel Order (NO)' }
                        ]
                    );
                    return;
                }

                // Step: Confirming Order (YES / NO)
                if (session.step === 'CONFIRM_ORDER') {
                    if (rawText === 'confirm_YES' || textLower === 'yes' || textLower === 'y' || textLower === 'ok') {
                        await sock.sendMessage(from, { text: "⏳ *Creating your order and payment link... Please wait.*" });

                        const buffer = Buffer.from(session.pending.bufferBase64, 'base64');
                        const form = new FormData();
                        form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype });
                        form.append('customerName', `${pushName} (${senderPhone})`);
                        form.append('phoneNumber', senderPhone);
                        form.append('blockLocation', session.blockLocation);
                        form.append('printType', session.pending.printType);

                        let response;
                        try {
                            response = await axios.post(BACKEND_URL, form, { headers: form.getHeaders(), timeout: 30000 });
                        } catch (primaryErr) {
                            const fallbackUrl = 'https://printer-backend-1.onrender.com/api/bot/direct-upload';
                            form.append('file', buffer, { filename: session.pending.filename, contentType: session.pending.mimetype });
                            response = await axios.post(fallbackUrl, form, { headers: form.getHeaders(), timeout: 30000 });
                        }

                        const resData = response.data || {};
                        const otp = resData.otp || '0001';
                        const orderId = resData.orderId || 'ORD2026';
                        const paymentUrl = resData.paymentUrl || `http://localhost:5173/checkout?orderId=${orderId}`;

                        // Message 1: Order Details & 4-Digit Release OTP
                        let otpMsg = `🖨️ *Cloud Print Order Created!*\n` +
                                     `-----------------------------------\n` +
                                     `📄 *File*: ${session.pending.filename}\n` +
                                     `📊 *Pages*: ${resData.totalPages || 1} | *Type*: ${session.pending.printType}\n` +
                                     `💰 *Total Amount*: ₹${(resData.estimatedTotal || session.pending.estimatedTotal).toFixed(2)}\n` +
                                     `🔐 *Your 4-Digit Release OTP*: *${otp}*\n` +
                                     `📍 *Target Kiosk*: ${session.blockLocation}`;

                        await sock.sendMessage(from, { text: otpMsg });

                        // Message 2: Separate Payment Link
                        let payMsg = `👉 *Click here to complete payment*:\n${paymentUrl}`;
                        await sock.sendMessage(from, { text: payMsg });

                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        return;
                    } else if (rawText === 'confirm_NO' || textLower === 'no' || textLower === 'n' || textLower === 'cancel') {
                        session.pending = null;
                        session.step = 'IDLE';
                        saveSessions(sessions);
                        await sock.sendMessage(from, { text: "❌ Order cancelled. You can attach a new file to print anytime!" });
                        return;
                    }
                }
            }

            // Default Greeting for Existing Users
            await sendInteractiveButtons(
                sock,
                from,
                `👋 Hello, ${pushName}!`,
                `Welcome to Cloud Print.\nFast, secure, and hassle-free document printing.\n\n📍 College: *${session.college}*\n🖨️ Active Kiosk: *${session.blockLocation || 'None'}*\n\nHow can we help you today?\n\n-----------------------------------\n1️⃣ *📤 Upload Document*\n2️⃣ *💰 Check Printing Price*\n3️⃣ *🔄 Change Kiosk Block*\n4️⃣ *📦 Track My Order*\n5️⃣ *🖨️ Print History*\n6️⃣ *🏢 Locate Print Shop*\n7️⃣ *☎ Contact Support*\n\n👉 *Reply 1-7 or send a command (e.g. 1, 2, 3, 'block', 'quit')!*`,
                'Cloud Print Menu',
                [
                    { id: 'opt_1', text: '📤 Upload Document' },
                    { id: 'opt_2', text: '💰 Check Price' },
                    { id: 'btn_change_block', text: '🔄 Change Kiosk' }
                ],
                senderPhone
            );

        } catch (error) {
            console.error("Error processing WhatsApp message:", error);
            try {
                if (m.messages && m.messages[0]) {
                    await sock.sendMessage(m.messages[0].key.remoteJid, { 
                        text: "❌ Error processing request. Please send a valid PDF or image file." 
                    });
                }
            } catch (e) {}
        }
    });
}

startBot();

