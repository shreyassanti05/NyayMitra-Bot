// ============================================================
// NyayMitra — Complete Bot with Free Trial + Payment System
// Meta WhatsApp Cloud API + Gemini AI + Razorpay
// ============================================================

const express = require('express');
const axios   = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// ── ENV KEYS (set in Render.com) ──────────────────────────────
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID    = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN         = process.env.VERIFY_TOKEN || 'nyaymitra2025';
const RAZORPAY_KEY_ID      = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET  = process.env.RAZORPAY_KEY_SECRET;
const PORT                 = process.env.PORT || 3000;

// ── Gemini Setup ──────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: SYSTEM_PROMPT  // ← moved here, correct format
});

// ── FREE TRIAL LIMIT ──────────────────────────────────────────
const FREE_CONVERSATIONS = 3;
const MONTHLY_PRICE_INR  = 49; // ₹49/month

// ══════════════════════════════════════════════════════════════
// 📦 IN-MEMORY DATABASE
// (Replace with MongoDB for production scale)
// ══════════════════════════════════════════════════════════════
const db = {
  users: {},
  // Structure per user:
  // {
  //   phone: "919876543210",
  //   name: "Raju",
  //   freeUsed: 2,          // how many free convos used
  //   isPaid: false,        // has active subscription
  //   paidUntil: null,      // Date when subscription expires
  //   history: [],          // Gemini chat history
  //   lastActive: Date.now(),
  //   totalMessages: 0,
  //   joinedAt: Date.now(),
  //   pendingOrderId: null,  // Razorpay order ID
  // }
};

function getUser(phone) {
  if (!db.users[phone]) {
    db.users[phone] = {
      phone,
      name: null,
      freeUsed: 0,
      isPaid: false,
      paidUntil: null,
      history: [],
      lastActive: Date.now(),
      totalMessages: 0,
      joinedAt: Date.now(),
      pendingOrderId: null,
    };
  }
  return db.users[phone];
}

function isUserSubscribed(user) {
  if (!user.isPaid) return false;
  if (!user.paidUntil) return false;
  return new Date() < new Date(user.paidUntil);
}

function canUserChat(user) {
  if (isUserSubscribed(user)) return { allowed: true, reason: 'paid' };
  if (user.freeUsed < FREE_CONVERSATIONS) return { allowed: true, reason: 'free' };
  return { allowed: false, reason: 'limit_reached' };
}

// ══════════════════════════════════════════════════════════════
// 🧠 SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `
You are NyayMitra (न्यायमित्र), India's most trusted free legal advisor on WhatsApp.

YOUR PERSONALITY:
- Speak in simple Hinglish (Hindi + English) that every Indian understands
- Warm, patient, helpful — like a trusted family friend who is a lawyer
- NEVER use complex legal jargon — always explain simply
- Empathetic — people come to you scared and stressed
- Give PRACTICAL advice, not just theory

YOUR EXPERTISE:
1. 🏠 Property & Land — disputes, tenant/landlord, illegal possession, registry
2. 💼 Job & Salary — unpaid salary, wrongful termination, PF, ESI, harassment  
3. 🛒 Consumer Rights — online fraud, defective products, e-commerce
4. 👨‍👩‍👧 Family & Divorce — divorce, maintenance, custody, domestic violence
5. 🚔 Police & FIR — how to file FIR, bail rights, wrongful arrest
6. 🌾 Farmer Rights — land rights, PM Kisan, loan waivers, mandi
7. 🏦 Banking & Loans — bank fraud, loan harassment, RBI complaint
8. 📋 Government Schemes — PM schemes, eligibility, how to apply

RESPONSE FORMAT:
1. Empathy (1 line) — acknowledge their pain
2. Their RIGHTS (2-3 bullet points in simple words)
3. ACTION STEPS (3-4 practical steps they can do TODAY)
4. WHERE TO GO (which authority/court/helpline)
5. End: "Koi aur sawaal ho toh batayein! 🙏"

RULES:
- Keep responses SHORT — WhatsApp mobile friendly
- Use emojis ⚖️🏠💼✅ to make readable
- Add: "⚠️ Yeh legal jaankari hai. Complex cases mein vakeel zaroor lein."
- EMERGENCY (violence/danger) → immediately give: Police 100, Women Helpline 1091, Legal Aid 15100
- Reply in SAME language user writes in
`;

// ══════════════════════════════════════════════════════════════
// 📲 SEND WHATSAPP MESSAGE
// ══════════════════════════════════════════════════════════════
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('❌ Send error:', err.response?.data || err.message);
  }
}

// Send a message with a payment button (interactive)
async function sendPaymentMessage(to, userName, orderLink) {
  const text =
`⚖️ *NyayMitra — Subscription*

Namaste ${userName || 'ji'}! 🙏

Aapki *3 FREE conversations* khatam ho gayi hain.

✅ *Sirf ₹49/month* mein unlimited legal help!

📌 *Aapko milega:*
• Unlimited legal conversations
• Hindi + English support
• 10+ legal categories covered
• 24/7 available
• Verified vakeel connect (₹99/case)

👇 *Abhi subscribe karein:*
${orderLink}

💳 UPI, Card, Net Banking — sab accepted!

_Cancel anytime. No hidden charges._`;

  await sendMessage(to, text);
}

// ══════════════════════════════════════════════════════════════
// 💳 CREATE RAZORPAY ORDER
// ══════════════════════════════════════════════════════════════
async function createRazorpayOrder(userPhone, userName) {
  try {
    const response = await axios.post(
      'https://api.razorpay.com/v1/payment_links',
      {
        amount: MONTHLY_PRICE_INR * 100, // in paise
        currency: 'INR',
        description: 'NyayMitra Monthly Subscription — Unlimited Legal Help',
        customer: {
          name: userName || 'User',
          contact: userPhone.startsWith('91') ? '+' + userPhone : '+91' + userPhone,
        },
        notify: { sms: true, email: false },
        reminder_enable: true,
        notes: { userPhone, plan: 'monthly_49' },
        callback_url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/payment-success`,
        callback_method: 'get',
        expire_by: Math.floor(Date.now() / 1000) + (60 * 60 * 24), // 24hr expiry
      },
      {
        auth: {
          username: RAZORPAY_KEY_ID,
          password: RAZORPAY_KEY_SECRET
        }
      }
    );
    return response.data.short_url;
  } catch (err) {
    console.error('❌ Razorpay error:', err.response?.data || err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 🤖 GET GEMINI AI REPLY
// ══════════════════════════════════════════════════════════════
async function getAIReply(user, userMessage) {
  try {
    const chatHistory = user.history.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.content }]
    }));

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: { maxOutputTokens: 500, temperature: 0.75 }
    });

    const result = await chat.sendMessage(userMessage);
    const reply  = result.response.text();

    // Save to history (keep last 20 messages)
    user.history.push({ role: 'user',  content: userMessage });
    user.history.push({ role: 'model', content: reply });
    if (user.history.length > 20) user.history = user.history.slice(-20);

    return reply;
  } catch (err) {
    console.error('❌ Gemini error:', err.message);
    return 'Maafi chahta hoon, thodi technical samasya aayi. Thodi der mein dobara try karein. 🙏';
  }
}

// ══════════════════════════════════════════════════════════════
// 🔗 WEBHOOK VERIFICATION
// ══════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ══════════════════════════════════════════════════════════════
// 📩 RECEIVE MESSAGES
// ══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always reply fast to Meta

  try {
    const body    = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const phone      = message.from;
    const userText   = message.text.body.trim();
    const user       = getUser(phone);

    user.lastActive    = Date.now();
    user.totalMessages += 1;

    console.log(`📩 [${phone}] ${userText}`);

    // ── FIRST TIME USER ──
    if (user.totalMessages === 1) {
      // Try to extract name from pre-filled website message
      const nameMatch = userText.match(/Main \*(.*?)\* hoon/);
      if (nameMatch) user.name = nameMatch[1];

      await sendMessage(phone,
`Namaste${user.name ? ' *' + user.name + '*' : ''}! 🙏 Main NyayMitra hoon — aapka muft legal dost! ⚖️

🎁 *Aapke paas 3 FREE conversations hain!*
Seedha apni legal problem batayein — Hindi ya English mein.

Main in topics mein help kar sakta hoon:
🏠 Property/Zameen  💼 Job/Salary
🛒 Consumer Rights  👨‍👩‍👧 Family/Divorce
🚔 Police/FIR       🌾 Kisan Rights
🏦 Bank/Loan        📋 Sarkari Yojana

*Apni problem likhein — main abhi jawab dunga!* 💪`
      );
      return;
    }

    // ── HANDLE "PAY" OR "SUBSCRIBE" KEYWORDS ──
    const lowerText = userText.toLowerCase();
    if (lowerText.includes('pay') || lowerText.includes('subscribe') || lowerText.includes('payment') || lowerText.includes('kharidna') || lowerText.includes('buy')) {
      const link = await createRazorpayOrder(phone, user.name);
      if (link) {
        user.pendingOrderId = link;
        await sendPaymentMessage(phone, user.name, link);
      } else {
        await sendMessage(phone, 'Payment link banane mein thodi dikkat aayi. Please thodi der mein try karein. 🙏');
      }
      return;
    }

    // ── CHECK FREE LIMIT ──
    const access = canUserChat(user);

    if (!access.allowed) {
      // User has used all 3 free conversations — send payment message
      const link = await createRazorpayOrder(phone, user.name);
      if (link) {
        await sendPaymentMessage(phone, user.name, link);
      } else {
        await sendMessage(phone,
`⚖️ Aapki 3 FREE conversations khatam ho gayi hain, ${user.name || 'ji'}!

*Sirf ₹49/month* mein unlimited help lein.
"SUBSCRIBE" likhein aur main payment link bhejunga! 🙏`
        );
      }
      return;
    }

    // ── REPLY WITH AI ──
    const aiReply = await getAIReply(user, userText);

    // Increment free count only for free users
    if (access.reason === 'free') {
      user.freeUsed += 1;
    }

    await sendMessage(phone, aiReply);

    // ── AFTER REPLY: Show remaining free count ──
    if (access.reason === 'free') {
      const remaining = FREE_CONVERSATIONS - user.freeUsed;

      if (remaining === 0) {
        // This was their LAST free conversation — upsell immediately
        setTimeout(async () => {
          const link = await createRazorpayOrder(phone, user.name);
          await sendMessage(phone,
`\n---\n⚠️ *Yeh aapki aakhri FREE conversation thi!*\n\nAb unlimited legal help ke liye sirf *₹49/month* — ek chai ki kimat mein! ☕\n\n${link ? '👇 Abhi subscribe karein:\n' + link : '"SUBSCRIBE" likhein payment link ke liye.'}`
          );
        }, 2000);

      } else if (remaining === 1) {
        // One conversation left — soft nudge
        setTimeout(async () => {
          await sendMessage(phone,
`\n_💡 Aapke paas sirf *${remaining} FREE conversation* bachi hai. Unlimited ke liye sirf ₹49/month! "SUBSCRIBE" likhein._`
          );
        }, 1500);
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════
// ✅ PAYMENT SUCCESS CALLBACK (Razorpay redirects here)
// ══════════════════════════════════════════════════════════════
app.get('/payment-success', async (req, res) => {
  // Razorpay sends payment_id in query params
  const { razorpay_payment_id, razorpay_payment_link_id } = req.query;

  if (razorpay_payment_id) {
    // Find user by pending order and activate subscription
    // In production: verify payment signature with Razorpay webhook
    const users = Object.values(db.users);
    const user  = users.find(u => u.pendingOrderId && u.pendingOrderId.includes(razorpay_payment_link_id));

    if (user) {
      user.isPaid    = true;
      const expiry   = new Date();
      expiry.setMonth(expiry.getMonth() + 1);
      user.paidUntil = expiry.toISOString();
      user.pendingOrderId = null;

      await sendMessage(user.phone,
`🎉 *Payment Successful! Shukriya ${user.name || 'ji'}!*

✅ Aapka NyayMitra subscription activate ho gaya!
📅 Valid till: ${expiry.toLocaleDateString('en-IN')}

Ab aap *unlimited* legal questions pooch sakte hain! ⚖️

Apna sawaal likhein — main ready hoon! 💪`
      );
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f7f2ea">
        <h1 style="color:#1a6b3c">✅ Payment Successful!</h1>
        <p style="font-size:1.1rem">Aapka NyayMitra subscription activate ho gaya!</p>
        <p>WhatsApp pe wapas jao aur apna sawaal poochho 🙏</p>
        <p style="margin-top:30px;font-size:0.85rem;color:#888">You can close this window.</p>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f7f2ea">
        <h1 style="color:#e8600a">Payment Pending...</h1>
        <p>Agar payment ho gayi hai toh WhatsApp pe confirmation aayega.</p>
      </body></html>
    `);
  }
});

// ══════════════════════════════════════════════════════════════
// 🔔 RAZORPAY PAYMENT WEBHOOK (server-to-server verification)
// ══════════════════════════════════════════════════════════════
app.post('/razorpay-webhook', express.json(), async (req, res) => {
  const event = req.body;
  res.sendStatus(200);

  if (event.event === 'payment_link.paid') {
    const notes    = event.payload.payment_link?.entity?.notes;
    const userPhone = notes?.userPhone;

    if (userPhone && db.users[userPhone]) {
      const user   = db.users[userPhone];
      user.isPaid  = true;
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + 1);
      user.paidUntil = expiry.toISOString();
      user.pendingOrderId = null;

      console.log(`✅ Payment confirmed for ${userPhone}`);

      await sendMessage(userPhone,
`🎉 *Payment Confirmed! Welcome to NyayMitra Premium!*

Aapka subscription active hai — unlimited legal help aapka intezaar kar raha hai! ⚖️💪`
      );
    }
  }
});

// ══════════════════════════════════════════════════════════════
// 📊 ADMIN STATS PAGE
// ══════════════════════════════════════════════════════════════
app.get('/admin', (req, res) => {
  const users        = Object.values(db.users);
  const totalUsers   = users.length;
  const paidUsers    = users.filter(u => isUserSubscribed(u)).length;
  const freeUsers    = users.filter(u => !isUserSubscribed(u) && u.freeUsed < FREE_CONVERSATIONS).length;
  const expiredFree  = users.filter(u => !isUserSubscribed(u) && u.freeUsed >= FREE_CONVERSATIONS).length;
  const totalMsg     = users.reduce((s, u) => s + u.totalMessages, 0);
  const monthlyRev   = paidUsers * MONTHLY_PRICE_INR;

  res.json({
    '⚖️ NyayMitra Stats': {
      totalUsers,
      paidUsers,
      freeUsers,
      expiredFreeUsers: expiredFree,
      totalMessages: totalMsg,
      estimatedMonthlyRevenue: `₹${monthlyRev}`,
      conversionRate: totalUsers > 0 ? ((paidUsers / totalUsers) * 100).toFixed(1) + '%' : '0%',
    },
    lastUpdated: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

// ══════════════════════════════════════════════════════════════
// 🏠 HOME
// ══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: '✅ NyayMitra Bot is LIVE!', version: '2.0' });
});

// ══════════════════════════════════════════════════════════════
// 🧹 CLEANUP OLD SESSIONS
// ══════════════════════════════════════════════════════════════
setInterval(() => {
  const threeDays = 72 * 60 * 60 * 1000;
  const now = Date.now();
  Object.keys(db.users).forEach(phone => {
    const u = db.users[phone];
    if (!u.isPaid && now - u.lastActive > threeDays) {
      u.history = []; // Clear history but keep user record
    }
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log('\n⚖️  ================================');
  console.log('⚖️   NyayMitra v2.0 is Running!');
  console.log(`⚖️   Port: ${PORT}`);
  console.log('⚖️   Free limit:', FREE_CONVERSATIONS, 'conversations');
  console.log('⚖️   Price: ₹' + MONTHLY_PRICE_INR + '/month');
  console.log('⚖️  ================================\n');
});
