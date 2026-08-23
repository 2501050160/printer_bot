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

    if (options.orientation) {
        const ori = String(options.orientation).toLowerCase().trim();
        if (ori === "landscape" || ori === "horizontal") {
            printOptions.orientation = "landscape";
        } else if (ori === "portrait") {
            printOptions.orientation = "portrait";
        }
    }

    console.log(`[Printer] Spooling PDF: ${path.basename(filePath)} | Printer: ${printOptions.printer || 'System Default'} | Mode: ${printOptions.monochrome ? 'Monochrome' : 'Color'} | Orientation: ${printOptions.orientation || 'portrait'} | Copies: ${printOptions.copies}`);
    await print(filePath, printOptions);
}

function detectPdfOrientation(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return "portrait";
        const buffer = fs.readFileSync(filePath);
        const slice = buffer.subarray(0, Math.min(buffer.length, 250000)).toString("binary");
        
        const rotateMatch = slice.match(/\/Rotate\s+(\d+)/);
        const rotation = rotateMatch ? parseInt(rotateMatch[1], 10) : 0;

        const boxMatch = slice.match(/\/(?:MediaBox|CropBox)\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/);
        if (boxMatch) {
            const width = Math.abs(parseFloat(boxMatch[3]) - parseFloat(boxMatch[1]));
            const height = Math.abs(parseFloat(boxMatch[4]) - parseFloat(boxMatch[2]));
            
            if (rotation === 90 || rotation === 270) {
                return height > width ? "landscape" : "portrait";
            }
            return width > height ? "landscape" : "portrait";
        }
    } catch (e) {
        console.warn("[Printer] Orientation detection warning:", e.message);
    }
    return "portrait";
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
    cleanup,
    detectPdfOrientation
};
