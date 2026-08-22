const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { printPdf, savePdfBuffer, cleanup } = require("./printer");

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const backendUrl = config.backendUrl.replace(/\/$/, "");
const pollIntervalMs = config.pollIntervalMs || 5000;

let isProcessing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resolvePrinterName(blockLocation, order = {}) {
    if (order.assignedPrinterName?.trim()) {
        return order.assignedPrinterName.trim();
    }

    const blockConfig = config.blocks.find(
        (block) => block.blockLocation === blockLocation
    );

    if (blockConfig?.printerName?.trim()) {
        return blockConfig.printerName.trim();
    }

    try {
        const response = await axios.get(
            `${backendUrl}/api/printer/byBlock`,
            {
                params: { blockLocation, printType: order.printType || "BW" }
            }
        );

        return response.data?.printerName || "";
    } catch (error) {
        console.warn(
            `Printer lookup failed for ${blockLocation}:`,
            error.message
        );
        return "";
    }
}

async function processBlock(blockConfig) {
    const { blockLocation, apiKey } = blockConfig;

    if (!apiKey) {
        console.warn(`[${blockLocation}] No API Key provided in config. Skipping.`);
        return;
    }

    const headers = {
        "Authorization": `Bearer ${apiKey.trim()}`
    };

    try {
        const nextResponse = await axios.get(
            `${backendUrl}/api/queue/next`,
            { 
                headers,
                params: { blockLocation }
            }
        );

    const order = nextResponse.data;

    if (!order || !order.orderId) {
        return;
    }

    console.log(
        `[${blockLocation}] Processing order ${order.orderId} (DoubleSided: ${order.doubleSided})`
    );
    console.log("Full order data:", JSON.stringify(order));

    await axios.post(
        `${backendUrl}/api/queue/startPrinting`,
        null,
        {
            params: { orderId: order.orderId },
            headers
        }
    );

    const downloadResponse = await axios.get(
        `${backendUrl}/api/pdf/download/${order.id}`,
        {
            responseType: "arraybuffer"
        }
    );

    const filePath = await savePdfBuffer(
        Buffer.from(downloadResponse.data),
        order.orderId
    );

    const printerName = await resolvePrinterName(blockLocation, order);

    await printPdf(filePath, {
        printerName,
        copies: order.copies || 1,
        side: order.doubleSided ? "duplexlong" : "simplex"
    });

    cleanup(filePath);

    // Print job pushed directly to OS spooler; mark order completed immediately
    await axios.post(
        `${backendUrl}/api/queue/complete`,
        null,
        {
            params: { orderId: order.orderId },
            headers
        }
    );

    console.log(
        `[${blockLocation}] Completed order ${order.orderId}`
    );
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.error(`[${blockLocation}] ERROR: Invalid API Key. Please regenerate the key in the Admin Dashboard.`);
        } else {
            console.error(`[${blockLocation}] Error processing block:`, error.message);
        }
    }
}

async function pollQueue() {
    if (isProcessing) {
        return;
    }

    isProcessing = true;

    try {
        for (const block of config.blocks) {
            await processBlock(block);
        }
    } catch (error) {
        console.error("Print agent error:", error.message);
    } finally {
        isProcessing = false;
    }
}

/**
 * Real-Time Event-Driven Architecture (SSE Stream):
 * Listens to push events from Render backend so we only fetch orders
 * when a print job is actually waiting, eliminating continuous HTTP requests.
 */
const http = require("http");
const https = require("https");

function connectSSE() {
    try {
        const sseUrl = new URL(`${backendUrl}/api/sse/stream`);
        const client = sseUrl.protocol === "https:" ? https : http;

        console.log(`📡 Connecting Print Agent to Real-Time SSE Stream (${sseUrl.href})...`);

        const req = client.get(sseUrl.href, {
            headers: {
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                console.warn(`⚠️ SSE Stream returned status ${res.statusCode}. Retrying in 15s...`);
                setTimeout(connectSSE, 15000);
                return;
            }

            console.log("✅ Print Agent connected to Real-Time Event Stream! (Zero idle HTTP requests)");

            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop(); // keep last incomplete line

                for (const line of lines) {
                    if (line.includes("QUEUE_UPDATED") || line.includes("ORDER_UPDATED")) {
                        console.log("⚡ [SSE Push Event] New print job triggered! Processing queue immediately...");
                        pollQueue();
                    }
                }
            });

            res.on("end", () => {
                console.log("📡 SSE Stream closed. Reconnecting in 5s...");
                setTimeout(connectSSE, 5000);
            });
        });

        req.on("error", (err) => {
            console.warn(`📡 SSE connection note: ${err.message}. Retrying in 15s...`);
            setTimeout(connectSSE, 15000);
        });
    } catch (err) {
        console.warn("Could not initiate SSE stream:", err.message);
        setTimeout(connectSSE, 15000);
    }
}

console.log("====================================================");
console.log("⚡ Cloud Print Agent started (100% Event-Driven SSE)");
console.log(`Backend URL: ${backendUrl}`);
console.log(`Blocks: ${config.blocks.map((b) => b.blockLocation).join(", ")}`);
console.log("====================================================");

// 1. Initial check on startup
pollQueue();

// 2. Connect to real-time event push stream (Zero Idle Requests / Event-Driven)
connectSSE();

