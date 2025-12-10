import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { QueueClient } from "@azure/storage-queue";
import { BlobServiceClient } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import dotenv from 'dotenv';
dotenv.config();

// Azure Storage Queue
const QUEUE_NAME = process.env.QUEUE_NAME || "incoming-messages";
const AZURE_QUEUE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION;
const queueClient = new QueueClient(AZURE_QUEUE_CONNECTION, QUEUE_NAME);

// Azure Blob Storage
const blobClient = BlobServiceClient.fromConnectionString(AZURE_QUEUE_CONNECTION);
const container = blobClient.getContainerClient("whatsapp-media");

// Upload to Blob
async function uploadToBlob(buffer, mime) {
  const ext = mime.split("/")[1] || "bin";
  const blobName = `${randomUUID()}.${ext}`;
  const blockBlob = container.getBlockBlobClient(blobName);

  await blockBlob.uploadData(buffer);
  return blockBlob.url;
}

async function sendToQueue(payload) {
  const msg = Buffer.from(JSON.stringify(payload)).toString("base64");
  await queueClient.sendMessage(msg);
  console.log("📤 → Azure Queue:", payload);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "open") console.log("✅ WhatsApp connected");
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
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

    // TEXT
    if (msg.message.conversation) {
      payload.text = msg.message.conversation;
    }
    if (msg.message.imageMessage?.caption) {
      payload.text = msg.message.imageMessage.caption;
    }
    if (msg.message.videoMessage?.caption) {
      payload.text = msg.message.videoMessage.caption;
    }
    if (msg.message.documentMessage?.caption) {
      payload.text = msg.message.documentMessage.caption;
    }

    // ⭐ PING → PONG auto handler
    if (payload.text && payload.text.toLowerCase().trim() === "ping") {
      await sock.sendMessage(chatId, { text: "pong" });
      console.log("🏓 Responded to ping with pong");
    }

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

      const buffer = await downloadMediaMessage(msg, "buffer");

      const blobUrl = await uploadToBlob(buffer, mime);
      payload.mediaUrl = blobUrl;

      console.log("📸 Media uploaded:", blobUrl);
    }

    // SEND to queue
    await sendToQueue(payload);
  });
}

start();
