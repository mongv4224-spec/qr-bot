require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");
const crypto = require("crypto");

// ===== CONFIG =====
const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID;
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY;

// ===== SERVER =====
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

// ===== TẠO LINK PAYOS =====
async function createPayment(amount, userId) {
    const orderCode = Date.now();

    const body = {
        orderCode,
        amount,
        description: `USER_${userId}`,
        returnUrl: "https://google.com",
        cancelUrl: "https://google.com"
    };

    const dataString = `amount=${amount}&cancelUrl=${body.cancelUrl}&description=${body.description}&orderCode=${orderCode}&returnUrl=${body.returnUrl}`;

    const signature = crypto
        .createHmac("sha256", PAYOS_CHECKSUM_KEY)
        .update(dataString)
        .digest("hex");

    const res = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
        method: "POST",
        headers: {
            "x-client-id": PAYOS_CLIENT_ID,
            "x-api-key": PAYOS_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            ...body,
            signature
        })
    });

    const json = await res.json();
    return json.data;
}

// ===== LỆNH !qr =====
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith("!qr")) return;

    if (!hasPermission(message.member)) {
        return message.reply("⛔ Không có quyền!");
    }

    const args = message.content.split(" ").slice(1);
    const amount = parseMoney(args[0]);

    if (!amount) return message.reply("❌ Ví dụ: !qr 50k");

    try {
        const payment = await createPayment(amount, message.author.id);

        const embed = new EmbedBuilder()
            .setTitle("💰 THANH TOÁN PAYOS")
            .setDescription(
                `💵 Số tiền: **${amount.toLocaleString("vi-VN")} VNĐ**\n\n` +
                `👉 Nhấn link để thanh toán:\n${payment.checkoutUrl}`
            )
            .setColor(0x00ff99);

        message.channel.send({ embeds: [embed] });

    } catch (err) {
        console.log(err);
        message.reply("❌ Lỗi tạo thanh toán!");
    }
});

// ===== WEBHOOK PAYOS =====
app.post("/webhook", async (req, res) => {
    const data = req.body;

    console.log("📡 PayOS:", data);

    if (data.code === "00" && data.data) {
        const desc = data.data.description || "";
        const match = desc.match(/USER_(\d+)/);

        if (!match) return res.sendStatus(200);

        const userId = match[1];

        try {
            // log kênh
            const channel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);

            if (channel) {
                await channel.send(
                    `💰 <@${userId}> đã thanh toán thành công!\n` +
                    `💵 ${data.data.amount.toLocaleString("vi-VN")} VNĐ`
                );
            }

            // dm user
            const user = await client.users.fetch(userId);
            await user.send("✅ Thanh toán thành công!");

        } catch (err) {
            console.log(err);
        }
    }

    res.sendStatus(200);
});

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🌐 Server chạy:", PORT);
});