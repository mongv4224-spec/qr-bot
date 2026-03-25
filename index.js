require("dotenv").config();

const express = require("express");
const https = require("https");
const crypto = require("crypto");
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField
} = require("discord.js");

// ===== CHECK ENV =====
if (!process.env.DISCORD_TOKEN) {
    console.error("❌ Thiếu DISCORD_TOKEN");
    process.exit(1);
}

// ===== SERVER =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
    res.send("✅ Bot + Webhook đang chạy");
});

// ===== DISCORD =====
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once("ready", () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// ===== LƯU PAYMENT =====
const pendingPayments = new Map();

// ===== CHECK ROLE =====
function hasPermission(member) {
    if (!member) return false;

    return member.roles.cache.has(process.env.ALLOWED_ROLE_ID) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ===== PARSE TIỀN =====
function parseMoney(input) {
    if (!input) return 0;
    input = input.toLowerCase();

    if (input.includes("k")) return parseInt(input) * 1000;
    if (input.includes("tr")) return parseInt(input) * 1000000;

    return parseInt(input.replace(/[^0-9]/g, ""));
}

// ===== CREATE PAYOS =====
async function createPayment(amount, userId) {
    const orderCode = Date.now();

    // 🔥 description NGẮN ≤ 25 ký tự
    const shortDesc = `U${userId.slice(-6)}_${orderCode.toString().slice(-6)}`;

    const body = {
        amount: amount,
        cancelUrl: "https://google.com",
        description: shortDesc,
        orderCode: orderCode,
        returnUrl: "https://google.com"
    };

    // 🔥 SORT KEY
    const sortedKeys = Object.keys(body).sort();
    const dataString = sortedKeys.map(k => `${k}=${body[k]}`).join("&");

    const signature = crypto
        .createHmac("sha256", process.env.PAYOS_CHECKSUM_KEY)
        .update(dataString)
        .digest("hex");

    console.log("📜 STRING:", dataString);
    console.log("🔐 SIGN:", signature);

    const res = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
        method: "POST",
        headers: {
            "x-client-id": process.env.PAYOS_CLIENT_ID,
            "x-api-key": process.env.PAYOS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...body, signature })
    });

    const json = await res.json();
    console.log("📦 PAYOS RESPONSE:", json);

    if (!json.data) {
        throw new Error(json.desc || "PayOS lỗi");
    }

    return json.data;
}

// ===== LỆNH !qr =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith("!qr")) return;

    if (!hasPermission(message.member)) {
        return message.reply("⛔ Không có quyền!");
    }

    const amount = parseMoney(message.content.split(" ")[1]);
    if (!amount) return message.reply("❌ Ví dụ: !qr 50k");

    try {
        const payment = await createPayment(amount, message.author.id);

        // ===== QR =====
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(payment.checkoutUrl)}`;

        const qr = await new Promise((resolve, reject) => {
            https.get(qrUrl, (res) => {
                const data = [];
                res.on("data", chunk => data.push(chunk));
                res.on("end", () => resolve(Buffer.concat(data)));
            }).on("error", reject);
        });

        const embed = new EmbedBuilder()
            .setTitle("🔴 CHƯA THANH TOÁN")
            .setDescription(
                `💵 **${amount.toLocaleString("vi-VN")} VNĐ**\n\n` +
                `👉 ${payment.checkoutUrl}`
            )
            .setImage("attachment://qr.png")
            .setColor(0xff0000);

        const sent = await message.channel.send({
            embeds: [embed],
            files: [{ attachment: qr, name: "qr.png" }]
        });

        pendingPayments.set(payment.orderCode, {
            messageId: sent.id,
            channelId: sent.channel.id,
            userId: message.author.id,
            amount
        });

    } catch (err) {
        console.log("❌ PayOS lỗi:", err.message);
        message.reply("❌ Lỗi PayOS! Check log!");
    }
});

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
    const data = req.body;
    console.log("📡 WEBHOOK:", data);

    if (data.code === "00" && data.data) {
        const orderCode = data.data.orderCode;
        const payment = pendingPayments.get(orderCode);

        if (!payment) return res.sendStatus(200);

        try {
            const channel = await client.channels.fetch(payment.channelId);
            const msg = await channel.messages.fetch(payment.messageId);

            const embed = new EmbedBuilder()
                .setTitle("🟢 ĐÃ THANH TOÁN")
                .setDescription(
                    `💵 **${payment.amount.toLocaleString("vi-VN")} VNĐ**\n\n✅ Thành công`
                )
                .setColor(0x00ff00);

            await msg.edit({ embeds: [embed], files: [] });

            // LOG
            const log = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
            if (log) {
                log.send(`💰 <@${payment.userId}> đã thanh toán ${payment.amount}`);
            }

            // DM
            const user = await client.users.fetch(payment.userId);
            user.send("✅ Thanh toán thành công!");

            pendingPayments.delete(orderCode);

        } catch (err) {
            console.log("❌ Update lỗi:", err);
        }
    }

    res.sendStatus(200);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🌐 Server chạy:", PORT);
});