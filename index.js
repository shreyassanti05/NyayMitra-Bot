// ============================================================
// NyayMitra v2.1 — Fixed & Complete
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
const FREE_CONVERSATIONS = 3;
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

PERSONALITY: Speak simple Hinglish. Warm and helpful like a trusted friend who is a lawyer. Never use legal jargon. Give practical advice.

EXPERTISE: Property disputes, Job/Salary issues, Consumer rights, Family/Divorce, Police/FIR, Farmer rights, Banking/Loans, Government schemes.

RESPONSE FORMAT:
1. One line empathy
2. Their RIGHTS in 2-3 simple bullet points  
3. ACTION STEPS - 3-4 things they can do TODAY
4. WHERE TO GO - authority or helpline
5. End: "Koi aur sawaal ho toh batayein! 🙏"

RULES: Keep SHORT for WhatsApp. Use emojis. Add disclaimer: "Note: Yeh legal jaankari hai, legal advice nahi." Emergency: give Police 100, Women Helpline 1091, Legal Aid 15100. Reply in same language as user.`;

// ── GEMINI AI SETUP ───────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
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

Namaste ${userName || 'ji'}! 🙏 Aapki 3 FREE conversations khatam ho gayi hain.

✅ *Sirf Rs.49/month* mein unlimited legal help!

${link ? '👇 Abhi subscribe karein:\n' + link : 'Reply SUBSCRIBE for payment link'}

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
    return 'Maafi chahta hoon, thodi technical samasya aayi. Thodi der mein dobara try karein. 🙏';
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
      const m = userText.match(/Main \*(.*?)\* hoon/);
      if (m) user.name = m[1];
      await sendMessage(phone,
`Namaste${user.name ? ' *' + user.name + '*' : ''}! 🙏 Main NyayMitra hoon - aapka muft legal dost! ⚖️

🎁 *Aapke paas 3 FREE conversations hain!*

Apni legal problem batayein:
🏠 Property  💼 Job/Salary  🛒 Consumer
👨‍👩‍👧 Family   🚔 Police/FIR  🌾 Kisan
🏦 Bank/Loan  📋 Sarkari Yojana

*Seedha apni problem likhein!* 💪`
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
          await sendMessage(phone, `⚠️ *Yeh aapki aakhri FREE conversation thi!*\n\nUnlimited help ke liye sirf *Rs.49/month*!\n\n${link || 'Reply SUBSCRIBE'}`);
        }, 2000);
      } else if (left === 1) {
        setTimeout(async () => {
          await sendMessage(phone, `_💡 Sirf *1 FREE conversation* bachi hai. Unlimited ke liye Rs.49/month - reply SUBSCRIBE._`);
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

app.get('/', (req, res) => res.json({ status: '✅ NyayMitra Bot LIVE!', version: '2.1' }));

app.listen(PORT, () => {
  console.log('\n⚖️  NyayMitra v2.1 Running on port', PORT, '\n');
});
