// Decode UPI QR code to extract the UPI ID
const fs = require('fs');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const file = 'C:/Users/tk620/discord-marketplace/upi-qr.png';
const png = PNG.sync.read(fs.readFileSync(file));
const { data, width, height } = png;

const code = jsQR(new Uint8ClampedArray(data.buffer), width, height);
if (code) {
    console.log('=== QR DECODED ===');
    console.log('Data:', code.data);
    // Parse UPI link
    if (code.data.startsWith('upi://')) {
        const url = new URL(code.data);
        const params = new URLSearchParams(url.search);
        console.log('UPI ID (pa):', params.get('pa'));
        console.log('Payee Name (pn):', params.get('pn'));
        console.log('Amount (am):', params.get('am'));
    }
} else {
    console.log('No QR code found in image');
}
