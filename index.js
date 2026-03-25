require("dotenv").config();

const express = require("express");
const https = require("https");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ===== EXPRESS =====
const app = express();
app.use(express.json());

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

// ===== CONFIG =====
const BANK_ID = "970422";
const ACCOUNT_NO = "0813729700";
const ACCOUNT_NAME = "TRUONG VO THANH PHONG";

// ===== CHECK ROLE =====
function hasPermission(member) {
    return member.roles.cache.has(process.env.ALLOWED_ROLE_ID);
}

// ===== PARSE TIỀN =====
function parseMoney(input) {
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
        console.log(err);
        message.reply("❌ Lỗi tạo QR!");
    }
});

// ===== WEBHOOK PAYOS =====
app.post("/webhook", async (req, res) => {
    const data = req.body;

    console.log("📡 Webhook:", data);

    if (data.code === "00") {
        const content = data.data?.description || "";
        const match = content.match(/USER_(\d+)/);

        if (!match) return res.sendStatus(200);

        const userId = match[1];

        try {
            const guild = await client.guilds.fetch(process.env.GUILD_ID);
            const member = await guild.members.fetch(userId);

            await member.roles.add(process.env.ROLE_ID);

            console.log("✅ Add role cho:", userId);
        } catch (err) {
            console.log("❌ Lỗi add role:", err);
        }
    }

    res.sendStatus(200);
});

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🌐 Server chạy cổng", PORT);
});