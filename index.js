require("dotenv").config();

const express = require("express");
const https = require("https");
const crypto = require("crypto");
const fetch = require("node-fetch"); // node-fetch@2
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField
} = require("discord.js");

// ===== CONFIG BANK =====
const BANK_ID = "970422"; // MB Bank
const ACCOUNT_NO = "0813729700";
const ACCOUNT_NAME = "TRUONG VO THANH PHONG";

// ===== SERVER =====
const app = express();
app.use(express.json());

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

// ===== STORE PAYMENT =====
const pendingPayments = new Map();

// ===== CHECK ROLE =====
function hasPermission(member) {
    if (!member) return false;
    return member.roles.cache.has(process.env.ALLOWED_ROLE_ID) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ===== PARSE MONEY =====
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

    const body = {
        amount,
        cancelUrl: "https://google.com",
        description: `U${userId.slice(-6)}`,
        orderCode,
        returnUrl: "https://google.com"
    };

    const sortedKeys = Object.keys(body).sort();
    const dataString = sortedKeys.map(k => `${k}=${body[k]}`).join("&");

    const signature = crypto
        .createHmac("sha256", process.env.PAYOS_CHECKSUM_KEY)
        .update(dataString)
        .digest("hex");

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

    if (!json.data) {
        console.log("❌ PayOS:", json);
        throw new Error(json.desc);
    }

    return json.data;
}

// ===== GET QR BANK =====
function getQR(amount, content) {
    return new Promise((resolve, reject) => {
        const url = `https://img.vietqr.io/image/${BANK_ID}-${ACCOUNT_NO}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(ACCOUNT_NAME)}`;
        https.get(url, (res) => {
            const data = [];
            res.on("data", chunk => data.push(chunk));
            res.on("end", () => resolve(Buffer.concat(data)));
        }).on("error", reject);
    });
}

// ===== COMMAND !qr =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith("!qr")) return;

    if (!hasPermission(message.member)) {
        return message.reply("⛔ Không có quyền!");
    }

    const amount = parseMoney(message.content.split(" ")[1]);
    if (!amount) return message.reply("❌ Ví dụ: !qr 50k");

    try {
        const payment = await createPayment(amount, message.author.id);
        const content = `PAY${payment.orderCode}`;
        const qr = await getQR(amount, content);

        const embed = new EmbedBuilder()
            .setTitle("🔴 CHƯA THANH TOÁN")
            .setDescription(
                `💵 **${amount.toLocaleString("vi-VN")} VNĐ**\n\n` +
                `📌 Nội dung CK: **${content}**\n\n` +
                `🏦 ${ACCOUNT_NAME}\nMB Bank: ${ACCOUNT_NO}`
            )
            .setImage("attachment://qr.png")
            .setColor(0xff0000);

        const sent = await message.channel.send({
            embeds: [embed],
            files: [{ attachment: qr, name: "qr.png" }]
        });

        pendingPayments.set(Number(payment.orderCode), {
            messageId: sent.id,
            channelId: sent.channel.id,
            userId: message.author.id,
            amount
        });

        console.log("🆕 Payment created:", payment.orderCode);

    } catch (err) {
        console.log("❌ PayOS lỗi:", err.message);
        message.reply("❌ Lỗi PayOS!");
    }
});

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
    console.log("📡 WEBHOOK RAW:", JSON.stringify(req.body, null, 2));
    const data = req.body;

    if (data.code === "00" && data.data) {
        const orderCode = Number(data.data.orderCode);
        console.log("🔎 orderCode:", orderCode);
        console.log("📦 PendingPayments keys:", Array.from(pendingPayments.keys()));

        const payment = pendingPayments.get(orderCode);
        console.log("📦 Payment found:", payment);

        if (!payment) {
            console.log("⚠️ Không tìm thấy orderCode trong pendingPayments");
            return res.sendStatus(200);
        }

        try {
            const channel = await client.channels.fetch(payment.channelId);
            const msg = await channel.messages.fetch(payment.messageId);
            const embed = new EmbedBuilder()
                .setTitle("🟢 ĐÃ THANH TOÁN")
                .setDescription(`💵 **${payment.amount.toLocaleString("vi-VN")} VNĐ**\n\n✅ Thành công`)
                .setColor(0x00ff00);
            await msg.edit({ embeds: [embed], files: [] });

            const log = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
            if (log) log.send(`💰 <@${payment.userId}> đã thanh toán ${payment.amount}`);

            const user = await client.users.fetch(payment.userId).catch(() => null);
            if (user) user.send("✅ Bạn đã thanh toán thành công!");

            pendingPayments.delete(orderCode);

        } catch (err) {
            console.log("❌ Update lỗi:", err);
        }
    }

    res.sendStatus(200);
});

// ===== CHECK ORDERCODE COMMAND =====
client.on("messageCreate", message => {
    if (!message.content.startsWith("!check")) return;
    const orderCode = Number(message.content.split(" ")[1]);
    const payment = pendingPayments.get(orderCode);
    if (payment) {
        message.reply(`✅ Found payment: ${payment.amount} VNĐ, user: <@${payment.userId}>`);
    } else {
        message.reply("❌ Không tìm thấy orderCode này!");
    }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🌐 Server chạy cổng", PORT);
});