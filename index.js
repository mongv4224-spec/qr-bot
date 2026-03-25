require("dotenv").config();

const express = require("express");
const https = require("https");
const PayOS = require("@payos/node");

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField
} = require("discord.js");

// ===== CONFIG BANK =====
const BANK_ID = "970422";           // MB Bank
const ACCOUNT_NO = "0813729700";
const ACCOUNT_NAME = "TRUONG VO THANH PHONG";

// ===== PAYOS SDK =====
const payOS = new PayOS(
    process.env.PAYOS_CLIENT_ID,
    process.env.PAYOS_API_KEY,
    process.env.PAYOS_CHECKSUM_KEY
);

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

// ===== STORE PAYMENT =====
const pendingPayments = new Map();

// ===== CHECK PERMISSION =====
function hasPermission(member) {
    if (!member) return false;
    return member.roles.cache.has(process.env.ALLOWED_ROLE_ID) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ===== PARSE MONEY =====
function parseMoney(input) {
    if (!input) return 0;
    input = input.toLowerCase().trim();
    if (input.includes("k")) return Math.floor(parseFloat(input) * 1000);
    if (input.includes("tr")) return Math.floor(parseFloat(input) * 1000000);
    return parseInt(input.replace(/[^0-9]/g, "")) || 0;
}

// ===== CREATE PAYMENT =====
async function createPayment(amount, userId) {
    const orderCode = Date.now();

    const body = {
        amount,
        cancelUrl: "https://google.com",
        description: `U${userId.slice(-6)}`,
        orderCode,
        returnUrl: "https://google.com"
    };

    const response = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
        method: "POST",
        headers: {
            "x-client-id": process.env.PAYOS_CLIENT_ID,
            "x-api-key": process.env.PAYOS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const json = await response.json();

    if (!json.data) {
        console.error("❌ PayOS Error:", json);
        throw new Error(json.desc || "Không tạo được yêu cầu thanh toán");
    }

    return json.data;
}

// ===== GET QR CODE =====
function getQR(amount, content) {
    return new Promise((resolve, reject) => {
        const url = `https://img.vietqr.io/image/${BANK_ID}-${ACCOUNT_NO}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(ACCOUNT_NAME)}`;
        https.get(url, (res) => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject);
    });
}

// ===== COMMAND !qr =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith("!qr")) return;

    if (!hasPermission(message.member)) {
        return message.reply("⛔ Bạn không có quyền sử dụng lệnh này!");
    }

    const amount = parseMoney(message.content.split(" ")[1]);
    if (amount < 1000) {
        return message.reply("❌ Ví dụ: `!qr 50k` hoặc `!qr 50000` (tối thiểu 1.000 VNĐ)");
    }

    try {
        const payment = await createPayment(amount, message.author.id);
        const content = `PAY${payment.orderCode}`;

        const qrBuffer = await getQR(amount, content);

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
            files: [{ attachment: qrBuffer, name: "qr.png" }]
        });

        pendingPayments.set(Number(payment.orderCode), {
            messageId: sent.id,
            channelId: sent.channel.id,
            userId: message.author.id,
            amount
        });

        console.log(`✅ Tạo payment thành công | Order: ${payment.orderCode} | ${amount}đ`);

    } catch (err) {
        console.error(err);
        message.reply("❌ Lỗi tạo thanh toán PayOS. Hãy thử lại sau!");
    }
});

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
    try {
        const webhookData = payOS.webhooks.verify(req.body);

        if (webhookData.code === "00" && webhookData.data?.orderCode) {
            const orderCode = Number(webhookData.data.orderCode);
            const payment = pendingPayments.get(orderCode);

            if (!payment) {
                console.log(`⚠️ Không tìm thấy orderCode: ${orderCode}`);
                return res.sendStatus(200);
            }

            const channel = await client.channels.fetch(payment.channelId);
            const msg = await channel.messages.fetch(payment.messageId).catch(() => null);

            if (msg) {
                const successEmbed = new EmbedBuilder()
                    .setTitle("🟢 ĐÃ THANH TOÁN")
                    .setDescription(`💵 **${payment.amount.toLocaleString("vi-VN")} VNĐ**\n\n✅ Thanh toán thành công!`)
                    .setColor(0x00ff00);

                await msg.edit({ embeds: [successEmbed], files: [] });
            }

            // Log channel
            const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
            if (logChannel) logChannel.send(`💰 <@${payment.userId}> đã thanh toán **${payment.amount.toLocaleString("vi-VN")} VNĐ**`);

            // DM user
            const user = await client.users.fetch(payment.userId).catch(() => null);
            if (user) user.send("✅ Thanh toán thành công! Cảm ơn bạn.").catch(() => {});

            pendingPayments.delete(orderCode);
            console.log(`✅ Cập nhật thành công orderCode: ${orderCode}`);
        }
    } catch (error) {
        console.error("❌ Webhook error:", error.message);
    }

    res.sendStatus(200);
});

// ===== COMMAND !check =====
client.on("messageCreate", (message) => {
    if (!message.content.startsWith("!check")) return;
    const orderCode = Number(message.content.split(" ")[1]);
    const payment = pendingPayments.get(orderCode);
    if (payment) {
        message.reply(`✅ Tìm thấy: ${payment.amount.toLocaleString("vi-VN")} VNĐ - User: <@${payment.userId}>`);
    } else {
        message.reply("❌ Không tìm thấy orderCode này!");
    }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server chạy trên port ${PORT}`);
});
