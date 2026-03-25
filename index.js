require("dotenv").config();

const express = require("express");
const https = require("https");
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

// 🔥 QUAN TRỌNG: nhận JSON + raw (PayOS cần)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== TEST ROUTE =====
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

// ===== CONFIG BANK =====
const BANK_ID = "970422";
const ACCOUNT_NO = "0813729700";
const ACCOUNT_NAME = "TRUONG VO THANH PHONG";

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

// ===== TẠO QR =====
async function generateQR(amount, addinfo) {
    return new Promise((resolve, reject) => {
        const url = `https://img.vietqr.io/image/${BANK_ID}-${ACCOUNT_NO}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(addinfo)}&accountName=${encodeURIComponent(ACCOUNT_NAME)}`;

        https.get(url, (res) => {
            if (res.statusCode !== 200) return reject("QR lỗi");

            const data = [];
            res.on("data", chunk => data.push(chunk));
            res.on("end", () => resolve(Buffer.concat(data)));
        }).on("error", reject);
    });
}

// ===== LỆNH !qr =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith("!qr")) return;

    if (!hasPermission(message.member)) {
        return message.reply("⛔ Bạn không có quyền!");
    }

    const args = message.content.split(" ").slice(1);
    const amount = parseMoney(args[0]);

    const addinfo = `USER_${message.author.id}`;

    if (!amount || amount <= 0) {
        return message.reply("❌ Ví dụ: !qr 100k");
    }

    try {
        const qr = await generateQR(amount, addinfo);

        const embed = new EmbedBuilder()
            .setColor(0xffcc00)
            .setTitle("💰 THANH TOÁN")
            .setDescription(
                `💵 Số tiền: **${amount.toLocaleString("vi-VN")} VNĐ**\n\n` +
                `📌 Nội dung CK: **${addinfo}**\n\n` +
                `🏦 ${ACCOUNT_NAME}\nMB Bank: ${ACCOUNT_NO}`
            )
            .setImage("attachment://qr.png")
            .setFooter({ text: "Quét QR và thanh toán" })
            .setTimestamp();

        await message.channel.send({
            embeds: [embed],
            files: [{ attachment: qr, name: "qr.png" }]
        });

    } catch (err) {
        console.log("❌ QR lỗi:", err);
        message.reply("❌ Lỗi tạo QR!");
    }
});

// ===== WEBHOOK PAYOS =====
app.post("/webhook", async (req, res) => {
    try {
        const data = req.body;

        console.log("📡 Webhook nhận:", JSON.stringify(data));

        // kiểm tra thành công
        if (data.code === "00" && data.data) {
            const content = data.data.description || "";
            const match = content.match(/USER_(\d+)/);

            if (!match) return res.sendStatus(200);

            const userId = match[1];

            // ===== LOG CHANNEL =====
            const channel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);

            if (channel) {
                await channel.send(
                    `💰 <@${userId}> đã thanh toán thành công!\n` +
                    `💵 Số tiền: ${data.data.amount?.toLocaleString("vi-VN") || "N/A"} VNĐ`
                );
            }

            // ===== DM USER =====
            const user = await client.users.fetch(userId);
            await user.send("✅ Bạn đã thanh toán thành công!");

            console.log("✅ Thanh toán xong:", userId);
        }

        res.sendStatus(200);

    } catch (err) {
        console.log("❌ Webhook lỗi:", err);
        res.sendStatus(500);
    }
});

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🌐 Server chạy cổng", PORT);
});