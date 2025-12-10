// -------------------------------
// IMPORTS
// -------------------------------
import makeWASocket, { useMultiFileAuthState, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
dotenv.config();
import { QueueClient } from "@azure/storage-queue";
import { BlobServiceClient } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import express from "express";


// -------------------------------
// ENV VARIABLES
// -------------------------------
const AZURE_STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;

// incoming queue (от WhatsApp → Azure)
const INCOMING_QUEUE_NAME = process.env.QUEUE_NAME || "incoming-messages";

// outgoing queue (от Azure → WhatsApp)
const OUTGOING_QUEUE_NAME = process.env.OUTGOING_QUEUE || "outgoing-messages";

const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER || "whatsapp-media";

if (!AZURE_STORAGE_CONNECTION) throw new Error("❌ Missing AZURE_STORAGE_CONNECTION");


// -------------------------------
// INIT QUEUES + BLOB
// -------------------------------
const incomingQueue = new QueueClient(AZURE_STORAGE_CONNECTION, INCOMING_QUEUE_NAME);
const outgoingQueue = new QueueClient(AZURE_STORAGE_CONNECTION, OUTGOING_QUEUE_NAME);

const blobService = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION);
const container = blobService.getContainerClient(BLOB_CONTAINER_NAME);


async function initAzure() {
    console.log("🔄 Initializing Azure resources...");

    await incomingQueue.createIfNotExists();
    console.log("📨 Incoming queue ready:", INCOMING_QUEUE_NAME);

    await outgoingQueue.createIfNotExists();
    console.log("📤 Outgoing queue ready:", OUTGOING_QUEUE_NAME);

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
// SEND MESSAGE TO INCOMING QUEUE
// -------------------------------
async function sendIncoming(payload) {
    const msg = Buffer.from(JSON.stringify(payload)).toString("base64");
    await incomingQueue.sendMessage(msg);
    console.log("📥 → Incoming queue:", payload);
}


// -------------------------------
// LISTEN TO OUTGOING-MESSAGES QUEUE (POLLING)
// -------------------------------
async function startOutgoingQueueListener(sock) {
    console.log("▶ Starting outgoing queue listener...");

    while (true) {
        try {
            const response = await outgoingQueue.receiveMessages({ numberOfMessages: 1 });

            if (!response.receivedMessageItems.length) {
                await new Promise(r => setTimeout(r, 1000)); // poll every 1 sec
                continue;
            }

            const msg = response.receivedMessageItems[0];
            const payload = JSON.parse(msg.messageText);

            console.log("📤 Outgoing message received:", payload);

            // --- Send to WhatsApp ---
            if (payload.type === "text") {
                await sock.sendMessage(payload.chatId, { text: payload.text });
            }

            if (payload.type === "media" && payload.mediaUrl) {
                const res = await fetch(payload.mediaUrl);
                const buffer = Buffer.from(await res.arrayBuffer());

                await sock.sendMessage(payload.chatId, {
                    [payload.mime.startsWith("image") ? "image" : "document"]: buffer,
                    mimetype: payload.mime,
                    caption: payload.text || null
                });
            }

            // delete message from queue
            await outgoingQueue.deleteMessage(msg.messageId, msg.popReceipt);
            console.log("✅ Outgoing message sent + deleted from queue");

        } catch (err) {
            console.error("❌ Outgoing queue error:", err);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
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
            
            // -------------------------------
            // START OUTGOING POLLING LOOP
            // -------------------------------
            startOutgoingQueueListener(sock);
        }
    });


    // -------------------------------
    // INCOMING WHATSAPP → INCOMING QUEUE
    // -------------------------------
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
            mime: null,
            fromMe: msg.key.fromMe || false
        };

        // TEXT
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
                msg.message.documentMessage?.mimetype;

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

        // SEND TO INCOMING QUEUE
        await sendIncoming(payload);
    });


}


// -------------------------------
// EXPRESS HEALTH SERVER
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
