require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");

// ===== TOKEN CHECK =====
console.log("🔍 TOKEN CHECK:", process.env.TOKEN ? "OK" : "❌ NULL");

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const ALLOWED_ROLE = "1412802347821695026"; // role được phép dùng lệnh
let orders = {};

// ===== AUTO SET WEBHOOK PAYOS =====
async function setWebhook() {
  if (!process.env.PAYOS_CLIENT_ID || !process.env.PAYOS_API_KEY) {
    console.log("⚠️ PAYOS config thiếu, bỏ qua setWebhook");
    return;
  }

  try {
    await axios.post(
      "https://api-merchant.payos.vn/confirm-webhook",
      { webhookUrl: "https://qr-bot-ib4w.onrender.com/webhook" },
      {
        headers: {
          "x-client-id": process.env.PAYOS_CLIENT_ID,
          "x-api-key": process.env.PAYOS_API_KEY
        }
      }
    );
    console.log("✅ Webhook OK");
  } catch (err) {
    console.log("⚠️ Webhook lỗi (bỏ qua):", err.response?.data || err.message);
  }
}

// ===== BOT READY =====
client.once("ready", async () => {
  console.log(`🤖 Bot đã online: ${client.user.tag}`);
  await setWebhook();
});

// ===== COMMAND QR =====
client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith("!qr")) return;
  if (msg.author.bot) return;

  // Kiểm tra role
  if (!msg.member?.roles?.cache.has(ALLOWED_ROLE)) {
    return msg.reply("❌ Bạn không có quyền dùng lệnh");
  }

  const args = msg.content.split(" ")[1];
  if (!args) return msg.reply("❌ Ví dụ: !qr 20k");

  let amount = args.toLowerCase().replace("k", "000");
  amount = parseInt(amount);

  if (isNaN(amount) || amount < 1000) {
    return msg.reply("❌ Số tiền không hợp lệ (≥ 1000đ)");
  }

  const orderCode = Date.now();
  const body = {
    orderCode,
    amount,
    description: `QR_${msg.author.id}`,
    returnUrl: "https://google.com",
    cancelUrl: "https://google.com"
  };

  const signature = crypto
    .createHmac("sha256", process.env.PAYOS_CHECKSUM_KEY)
    .update(JSON.stringify(body))
    .digest("hex");

  try {
    const res = await axios.post(
      "https://api-merchant.payos.vn/v2/payment-requests",
      body,
      {
        headers: {
          "x-client-id": process.env.PAYOS_CLIENT_ID,
          "x-api-key": process.env.PAYOS_API_KEY,
          "x-signature": signature
        },
        timeout: 10000 // timeout 10s
      }
    );

    // Log toàn bộ response để debug nếu lỗi
    console.log("✅ PayOS response:", res.data);

    if (!res.data || !res.data.data || !res.data.data.qrCode) {
      console.error("❌ PayOS trả dữ liệu không hợp lệ:", res.data);
      return msg.reply("❌ Lỗi PayOS, không tạo được QR");
    }

    const data = res.data.data;

    orders[orderCode] = {
      userId: msg.author.id,
      channelId: msg.channel.id,
      amount
    };

    const embed = new EmbedBuilder()
      .setTitle("🧾 HOÁ ĐƠN")
      .addFields(
        { name: "👤 Khách", value: `<@${msg.author.id}>` },
        { name: "💰 Số tiền", value: `${amount.toLocaleString()}đ` },
        { name: "🔢 Mã đơn", value: `${orderCode}` },
        { name: "⏳ Trạng thái", value: "Chờ thanh toán" }
      )
      .setImage(data.qrCode)
      .setColor("Yellow");

    msg.reply({ embeds: [embed] });
  } catch (err) {
    console.error("❌ Lỗi tạo QR:", err.response?.data || err.message);
    msg.reply("❌ Lỗi tạo QR, kiểm tra log");
  }
});

// ===== LOGIN DISCORD =====
if (!process.env.TOKEN) {
  console.error("❌ TOKEN Discord chưa set!");
} else {
  client.login(process.env.TOKEN)
    .then(() => console.log("✅ Đã login Discord"))
    .catch(err => console.error("❌ TOKEN LỖI:", err));
}

// ===== EXPRESS SERVER =====
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const data = req.body;

  if (data.code === "00") {
    const orderCode = data.data.orderCode;
    const order = orders[orderCode];
    if (!order) return res.sendStatus(200);

    try {
      const channel = await client.channels.fetch(order.channelId);
      const embed = new EmbedBuilder()
        .setTitle("✅ ĐÃ THANH TOÁN")
        .addFields(
          { name: "👤 Khách", value: `<@${order.userId}>` },
          { name: "💰 Số tiền", value: `${order.amount.toLocaleString()}đ` },
          { name: "🔢 Mã", value: `${orderCode}` }
        )
        .setColor("Green");

      await channel.send({ embeds: [embed] });

      let history = [];
      try {
        history = JSON.parse(fs.readFileSync("./orders.json"));
      } catch {}

      history.push({
        user: order.userId,
        amount: order.amount,
        orderCode,
        time: Date.now()
      });

      fs.writeFileSync("./orders.json", JSON.stringify(history, null, 2));
      delete orders[orderCode];
    } catch (err) {
      console.error("❌ Lỗi webhook:", err);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook chạy cổng ${PORT}`));

// ===== BẮT LỖI ẨN =====
process.on("unhandledRejection", err => {
  console.error("❌ Lỗi hệ thống:", err);
});