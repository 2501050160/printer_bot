const { print } = require("pdf-to-printer");
const fs = require("fs");
const path = require("path");
const os = require("os");

async function printPdf(filePath, options = {}) {
    const printOptions = {
        copies: options.copies || 1,
        scale: options.scale || "fit",
        paperSize: options.paperSize || "A4"
    };

    if (options.printerName && options.printerName.trim()) {
        printOptions.printer = options.printerName.trim();
    }

    if (options.side) {
        printOptions.side = options.side;
    }

    if (options.pages && options.pages !== "ALL") {
        printOptions.pages = options.pages;
    }

    const isColor = options.printType && options.printType.toUpperCase() === "COLOR";
    if (options.monochrome !== undefined) {
        printOptions.monochrome = Boolean(options.monochrome);
    } else {
        printOptions.monochrome = !isColor;
    }

    console.log(`[Printer] Spooling PDF: ${path.basename(filePath)} | Printer: ${printOptions.printer || 'System Default'} | Mode: ${printOptions.monochrome ? 'Monochrome (Compact Spool)' : 'Color'} | Copies: ${printOptions.copies}`);
    await print(filePath, printOptions);
}

async function savePdfBuffer(buffer, orderId) {
    const tempDir = path.join(os.tmpdir(), "cloud-print-agent");

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const filePath = path.join(tempDir, `${orderId}.pdf`);

    fs.writeFileSync(filePath, buffer);

    return filePath;
}

function cleanup(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn("Unable to delete temp file:", error.message);
    }
}

module.exports = {
    printPdf,
    savePdfBuffer,
    cleanup
};
