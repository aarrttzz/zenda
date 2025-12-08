// -------------------------------
// IMPORTS
// -------------------------------
import makeWASocket, { useMultiFileAuthState, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { QueueClient } from "@azure/storage-queue";
import { BlobServiceClient } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import express from "express";


// -------------------------------
// ENV VARIABLES
// -------------------------------
const AZURE_STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const QUEUE_NAME = process.env.QUEUE_NAME || "incoming-messages";
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER || "whatsapp-media";

if (!AZURE_STORAGE_CONNECTION) throw new Error("❌ Missing AZURE_STORAGE_CONNECTION");
if (!QUEUE_NAME) throw new Error("❌ Missing QUEUE_NAME");


// -------------------------------
// INIT QUEUE + BLOB
// -------------------------------
const queueClient = new QueueClient(AZURE_STORAGE_CONNECTION, QUEUE_NAME);
const blobService = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION);
const container = blobService.getContainerClient(BLOB_CONTAINER_NAME);


async function initAzure() {
    console.log("🔄 Initializing Azure resources...");

    // Создаём queue если нет
    await queueClient.createIfNotExists();
    console.log("📨 Queue ready:", QUEUE_NAME);

    // Создаём blob container если нет
    await container.createIfNotExists();
    console.log("🗂 Blob container ready:", BLOB_CONTAINER_NAME);
}


// -------------------------------
// UPLOAD MEDIA TO BLOB
// -------------------------------
async function uploadToBlob(buffer, mime) {
    const ext = mime.split("/")[1] || "bin";
    const blobName = `${randomUUID()}.${ext}`;
    const client = container.getBlockBlobClient(blobName);

    await client.uploadData(buffer);
    return client.url;
}


// -------------------------------
// SEND MESSAGE TO QUEUE
// -------------------------------
async function sendToQueue(payload) {
    const msg = Buffer.from(JSON.stringify(payload)).toString("base64");
    await queueClient.sendMessage(msg);
    console.log("📤 → Azure Queue:", payload);
}


// -------------------------------
// START WHATSAPP
// -------------------------------
async function startWhatsApp() {
    await initAzure();

    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, qr }) => {
        if (qr) {
            console.clear();
            console.log("📱 Scan QR to log into WhatsApp:");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "open") {
            console.log("✅ WhatsApp connected.");
        }
    });

    // INCOMING MESSAGES
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;

        let payload = {
            chatId,
            sender,
            timestamp: Date.now(),
            type: "text",
            text: null,
            mediaUrl: null,
            mime: null
        };

        // TEXT MESSAGES
        if (msg.message.conversation) payload.text = msg.message.conversation;
        if (msg.message.extendedTextMessage?.text) payload.text = msg.message.extendedTextMessage.text;

        // CAPTIONS
        const caption =
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            null;

        if (caption) payload.text = caption;

        // MEDIA
        if (
            msg.message.imageMessage ||
            msg.message.videoMessage ||
            msg.message.documentMessage
        ) {
            payload.type = "media";

            const mime =
                msg.message.imageMessage?.mimetype ||
                msg.message.videoMessage?.mimetype ||
                msg.message.documentMessage?.mimetype ||
                "application/octet-stream";

            payload.mime = mime;

            try {
                const buffer = await downloadMediaMessage(msg, "buffer");
                const url = await uploadToBlob(buffer, mime);
                payload.mediaUrl = url;

                console.log("📸 Uploaded media:", url);
            } catch (err) {
                console.error("❌ Failed to process media:", err);
            }
        }

        // SEND TO QUEUE
        await sendToQueue(payload);
    });
}


// -------------------------------
// EXPRESS HEALTH SERVER (REQUIRED FOR AZURE)
// -------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("WhatsApp Bot is running."));
app.listen(PORT, () => console.log("🌐 HTTP server running on port", PORT));


// -------------------------------
// START BOT
// -------------------------------
startWhatsApp().catch(err => {
    console.error("❌ Fatal error in WhatsApp bot:", err);
});
