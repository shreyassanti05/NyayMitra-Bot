// ============================================================
// NyayMitra v2.1 — English Version
// Meta WhatsApp Cloud API + Gemini AI + Razorpay
// ============================================================

const express = require('express');
const axios   = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// ── ENV KEYS ──────────────────────────────────────────────────
const GEMINI_API_KEY      = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN      = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID   = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN        = process.env.VERIFY_TOKEN || 'nyaymitra2025';
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const PORT                = process.env.PORT || 3000;

// ── FREE TRIAL CONFIG ─────────────────────────────────────────
const FREE_CONVERSATIONS = 6;
const MONTHLY_PRICE_INR  = 49;

// ── IN-MEMORY DATABASE ────────────────────────────────────────
const db = { users: {} };

function getUser(phone) {
  if (!db.users[phone]) {
    db.users[phone] = {
      phone, name: null,
      freeUsed: 0, isPaid: false, paidUntil: null,
      history: [], lastActive: Date.now(), totalMessages: 0,
    };
  }
  return db.users[phone];
}

function isUserSubscribed(user) {
  return user.isPaid && user.paidUntil && new Date() < new Date(user.paidUntil);
}

function canUserChat(user) {
  if (isUserSubscribed(user)) return { allowed: true, reason: 'paid' };
  if (user.freeUsed < FREE_CONVERSATIONS) return { allowed: true, reason: 'free' };
  return { allowed: false, reason: 'limit_reached' };
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are NyayMitra, India's trusted free legal advisor on WhatsApp.

PERSONALITY: Speak in clear, simple English. Be warm and helpful like a trusted friend who is a lawyer. Never use complex legal jargon. Give practical, actionable advice.

EXPERTISE: Property disputes, Job/Salary issues, Consumer rights, Family/Divorce, Police/FIR, Farmer rights, Banking/Loans, Government schemes.

RESPONSE FORMAT:
1. One line of empathy — acknowledge their problem kindly
2. Their RIGHTS — 2-3 simple bullet points
3. ACTION STEPS — 3-4 things they can do TODAY
4. WHERE TO GO — which authority, court, or helpline to contact
5. End with: "Feel free to ask if you have more questions! 🙏"

RULES:
- Keep responses SHORT and easy to read on mobile
- Use emojis to make it friendly and scannable
- Always add: "Note: This is legal information, not legal advice. For complex matters, please consult a qualified lawyer."
- EMERGENCY (violence/danger): immediately provide Police 100, Women Helpline 1091, Legal Aid 15100
- Always reply in English`;

// ── GEMINI AI SETUP ───────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  systemInstruction: SYSTEM_PROMPT
});

// ── SEND WHATSAPP MESSAGE ─────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Sent to ${to}`);
  } catch (err) {
    console.error('❌ Send error:', err.response?.data || err.message);
  }
}

// ── SEND PAYMENT MESSAGE ──────────────────────────────────────
async function sendPaymentMessage(to, userName, link) {
  await sendMessage(to,
`⚖️ *NyayMitra — Subscribe Now*

Hello ${userName || 'there'}! 🙏 Your *3 FREE conversations* have been used.

✅ Get *unlimited legal help for just Rs.49/month!*

📌 *What you get:*
• Unlimited legal conversations
• English support
• 10+ legal categories covered
• Available 24/7
• Connect with a verified lawyer (Rs.99/case)

${link ? '👇 Subscribe now:\n' + link : 'Reply SUBSCRIBE for the payment link'}

_Cancel anytime. No hidden charges._`
  );
}

// ── RAZORPAY PAYMENT LINK ─────────────────────────────────────
async function createRazorpayOrder(userPhone, userName) {
  if (!RAZORPAY_KEY_ID) return null;
  try {
    const res = await axios.post(
      'https://api.razorpay.com/v1/payment_links',
      {
        amount: MONTHLY_PRICE_INR * 100, currency: 'INR',
        description: 'NyayMitra Monthly Subscription',
        customer: { name: userName || 'User', contact: '+' + userPhone },
        notes: { userPhone },
        expire_by: Math.floor(Date.now() / 1000) + 86400,
      },
      { auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET } }
    );
    return res.data.short_url;
  } catch (err) {
    console.error('❌ Razorpay error:', err.response?.data || err.message);
    return null;
  }
}

// ── GEMINI AI REPLY ───────────────────────────────────────────
async function getAIReply(user, userMessage) {
  try {
    const chat = model.startChat({
      history: user.history.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 500, temperature: 0.75 }
    });
    const result = await chat.sendMessage(userMessage);
    const reply  = result.response.text();
    user.history.push({ role: 'user', content: userMessage });
    user.history.push({ role: 'model', content: reply });
    if (user.history.length > 20) user.history = user.history.slice(-20);
    return reply;
  } catch (err) {
    console.error('❌ Gemini error:', err.message);
    return 'Sorry, we are facing a technical issue right now. Please try again in a moment. 🙏';
  }
}

// ── WEBHOOK VERIFY ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ── RECEIVE MESSAGES ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    if (req.body.object !== 'whatsapp_business_account') return;
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const phone    = message.from;
    const userText = message.text.body.trim();
    const user     = getUser(phone);
    user.lastActive = Date.now();
    user.totalMessages += 1;
    console.log(`📩 [${phone}] ${userText}`);

    // First message — welcome
    if (user.totalMessages === 1) {
      const m = userText.match(/My name is \*(.*?)\*/);
      if (m) user.name = m[1];
      await sendMessage(phone,
`Hello${user.name ? ' *' + user.name + '*' : ''}! 🙏 I am NyayMitra — your free legal assistant! ⚖️

🎁 *You have 3 FREE conversations!*

Tell me your legal problem and I will help you right away.

I can help with:
🏠 Property   💼 Job/Salary   🛒 Consumer Rights
👨‍👩‍👧 Family    🚔 Police/FIR   🌾 Farmer Rights
🏦 Bank/Loan  📋 Government Schemes

*Just type your problem and I will guide you!* 💪`
      );
      return;
    }

    // Subscribe keywords
    if (['pay','subscribe','payment'].some(k => userText.toLowerCase().includes(k))) {
      const link = await createRazorpayOrder(phone, user.name);
      await sendPaymentMessage(phone, user.name, link);
      return;
    }

    // Check access
    const access = canUserChat(user);
    if (!access.allowed) {
      const link = await createRazorpayOrder(phone, user.name);
      await sendPaymentMessage(phone, user.name, link);
      return;
    }

    // AI Reply
    const reply = await getAIReply(user, userText);
    if (access.reason === 'free') user.freeUsed += 1;
    await sendMessage(phone, reply);

    // Nudge messages
    if (access.reason === 'free') {
      const left = FREE_CONVERSATIONS - user.freeUsed;
      if (left === 0) {
        setTimeout(async () => {
          const link = await createRazorpayOrder(phone, user.name);
          await sendMessage(phone, `⚠️ *That was your last FREE conversation!*\n\nGet unlimited legal help for just *Rs.49/month* — the price of a cup of tea! ☕\n\n${link ? '👇 Subscribe now:\n' + link : 'Reply SUBSCRIBE for the payment link'}`);
        }, 2000);
      } else if (left === 1) {
        setTimeout(async () => {
          await sendMessage(phone, `_💡 You have only *1 FREE conversation* left. Get unlimited access for Rs.49/month — reply SUBSCRIBE._`);
        }, 1500);
      }
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const users = Object.values(db.users);
  res.json({
    totalUsers: users.length,
    paidUsers: users.filter(u => isUserSubscribed(u)).length,
    totalMessages: users.reduce((s, u) => s + u.totalMessages, 0),
    revenue: `Rs.${users.filter(u => isUserSubscribed(u)).length * MONTHLY_PRICE_INR}/month`,
    lastUpdated: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

app.get('/', (req, res) => res.json({ status: '✅ NyayMitra Bot LIVE!', version: '2.1-EN' }));

app.listen(PORT, () => {
  console.log('\n⚖️  NyayMitra v2.1 (English) Running on port', PORT, '\n');
});
