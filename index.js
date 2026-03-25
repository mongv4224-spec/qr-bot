require("dotenv").config();

const express = require("express");
const https = require("https");
const crypto = require("crypto");
const fetch = require("node-fetch");
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

// ===== PAYOS =====
const payOS = new PayOS(
    process.env.PAYOS_CLIENT_ID,
    process.env.PAYOS_API_KEY,
    process.env.PAYOS_CHECKSUM_KEY
);

// ===== SERVER =====
const app = express();

// Middleware cho webhook (bắt buộc dùng raw body)
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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

// ===== CHECK ROLE =====
function hasPermission(member) {
    if (!member) return false;
    return member.roles.cache.has(process.env.ALLOWED_ROLE_ID) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ===== PARSE MONEY =====
function parseMoney(input) {
    if (!input) return 0;
    input = input.toLowerCase().trim();
    if (input.includes("k")) return parseInt(input) * 1000;
    if (input.includes("tr")) return parseInt(input) * 1000000;
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

    const res = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
        method: "POST",
        headers: {
            "x-client-id": process.env.PAYOS_CLIENT_ID,
            "x-api-key": process.env.PAYOS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const json = await res.json();

    if (!json.data) {
        console.error("❌ PayOS Error:", json);
        throw new Error(json.desc || "Lỗi tạo link thanh toán");
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
        return message.reply("⛔ Không có quyền sử dụng lệnh này!");
    }

    const args = message.content.split(" ");
    const amount = parseMoney(args[1]);
    if (!amount || amount < 1000) {
        return message.reply("❌ Ví dụ: `!qr 50k` hoặc `!qr 50000` (tối thiểu 1.000đ)");
    }

    try {
        const payment = await createPayment(amount, message.author.id);
        const content = `PAY${payment.orderCode}`;

        const qrBuffer = await getQR(amount, content);

        const embed = new EmbedBuilder()
            .setTitle("🔴 CHƯA THANH TOÁN")
            .setDescription(
                `💵 **${amount.toLocaleString("vi-VN")} VNĐ**\n\n` +
                `📌 Nội dung chuyển khoản: **${content}**\n\n` +
                `🏦 ${ACCOUNT_NAME}\n` +
                `MB Bank: ${ACCOUNT_NO}`
            )
            .setImage("attachment://qr.png")
            .setColor(0xff0000)
            .setFooter({ text: "Quét mã QR hoặc chuyển khoản đúng nội dung để thanh toán" });

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

        console.log(`🆕 Payment created | OrderCode: ${payment.orderCode} | Amount: ${amount}đ`);

    } catch (err) {
        console.error("❌ Lỗi tạo payment:", err.message);
        message.reply("❌ Lỗi khi tạo yêu cầu thanh toán từ PayOS. Vui lòng thử lại sau!");
    }
});

// ===== WEBHOOK PAYOS =====
app.post("/webhook", async (req, res) => {
    console.log("📡 Nhận webhook từ PayOS");

    try {
        // Verify webhook bằng SDK
        const webhookData = payOS.webhooks.verify(req.body);

        console.log("✅ Webhook verified thành công");
        console.log("📦 Webhook Data:", JSON.stringify(webhookData, null, 2));

        if (webhookData.code === "00" && webhookData.data && webhookData.data.orderCode) {
            const orderCode = Number(webhookData.data.orderCode);
            const payment = pendingPayments.get(orderCode);

            if (!payment) {
                console.log(`⚠️ Không tìm thấy orderCode ${orderCode} trong pendingPayments`);
                return res.sendStatus(200);
            }

            // Update embed thành đã thanh toán
            try {
                const channel = await client.channels.fetch(payment.channelId);
                const msg = await channel.messages.fetch(payment.messageId);

                const successEmbed = new EmbedBuilder()
                    .setTitle("🟢 ĐÃ THANH TOÁN")
                    .setDescription(`💵 **${payment.amount.toLocaleString("vi-VN")} VNĐ**\n\n✅ Thanh toán thành công!`)
                    .setColor(0x00ff00)
                    .setTimestamp();

                await msg.edit({ embeds: [successEmbed], files: [] });

                // Gửi log
                const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
                if (logChannel) {
                    logChannel.send(`💰 <@${payment.userId}> đã thanh toán **${payment.amount.toLocaleString("vi-VN")} VNĐ** (Order: ${orderCode})`);
                }

                // DM cho user
                const user = await client.users.fetch(payment.userId).catch(() => null);
                if (user) {
                    user.send(`✅ Thanh toán thành công **${payment.amount.toLocaleString("vi-VN")} VNĐ**!\nCảm ơn bạn đã ủng hộ.`).catch(() => {});
                }

                pendingPayments.delete(orderCode);
                console.log(`✅ Đã cập nhật thành công cho orderCode: ${orderCode}`);

            } catch (updateErr) {
                console.error("❌ Lỗi khi update embed:", updateErr);
            }
        }
    } catch (error) {
        console.error("❌ Webhook không hợp lệ hoặc lỗi verify:", error.message);
        // Vẫn trả 200 để PayOS không retry liên tục
    }

    res.sendStatus(200);
});

// ===== COMMAND !check =====
client.on("messageCreate", (message) => {
    if (!message.content.startsWith("!check")) return;

    const orderCode = Number(message.content.split(" ")[1]);
    if (!orderCode) return message.reply("❌ Sai cú pháp: `!check <orderCode>`");

    const payment = pendingPayments.get(orderCode);
    if (payment) {
        message.reply(`✅ Tìm thấy:\n• Số tiền: ${payment.amount.toLocaleString("vi-VN")} VNĐ\n• User: <@${payment.userId}>`);
    } else {
        message.reply("❌ Không tìm thấy orderCode này trong danh sách đang chờ!");
    }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server đang chạy tại cổng ${PORT}`);
    console.log("🔗 Đừng quên set Webhook URL trong PayOS Dashboard thành:");
    console.log(`   https://your-domain.com/webhook`);
});
