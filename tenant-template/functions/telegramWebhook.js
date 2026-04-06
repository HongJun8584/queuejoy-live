'use strict';

const fetch = globalThis.fetch || require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_BASE = 'https://queuejoy.netlify.app';
const EXPLORE_URL = 'https://helloqueuejoy.netlify.app';

function safe(v, d = '') {
  if (v === 0) return '0';
  if (!v) return d;
  return String(v).trim() || d;
}

function now() {
  return new Date().toISOString();
}

/* ================= TELEGRAM ================= */

async function send(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }),
  });
}

/* ================= FIREBASE ================= */

function adminInit() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

/* ================= TOKEN ================= */

async function getToken(db, token) {
  let snap = await db.ref(`telegramTokens/${token}`).get();
  if (snap.exists()) return snap.val();

  const slugs = (await db.ref('slugs').get()).val() || {};
  for (const s in slugs) {
    const t = typeof slugs[s] === 'string' ? slugs[s] : slugs[s].tenantId;

    let a = await db.ref(`tenants/${t}/integrations/telegram/tokens/${token}`).get();
    if (a.exists()) return a.val();

    let b = await db.ref(`tenants/${t}/telegramTokens/${token}`).get();
    if (b.exists()) return b.val();
  }
  return null;
}

/* ================= QUEUE ================= */

async function findQueue(db, tenantId, token) {
  const queues = (await db.ref(`tenants/${tenantId}/public/queues`).get()).val() || {};

  for (const k in queues) {
    const q = queues[k];

    if (
      k === token.queueKey ||
      q.queueId === token.queueId ||
      q.queueNumber === token.queueNumber
    ) {
      return { key: k, data: q };
    }
  }
  return null;
}

async function getCounterName(db, tenantId, q, token) {
  if (q.counterName) return q.counterName;
  if (token.counterName) return token.counterName;

  const id = q.counterId || token.counterId;
  if (!id) return 'your counter';

  const c = await db.ref(`tenants/${tenantId}/counters/${id}`).get();
  if (c.exists()) return c.val().name || 'your counter';

  return 'your counter';
}

/* ================= CONNECT ================= */

async function connect(db, token, chatId) {
  const tenantId = token.tenantId;
  if (!tenantId) return null;

  const q = await findQueue(db, tenantId, token);
  if (!q) return null;

  const updates = {
    chatId,
    telegramChatId: chatId,
    telegramConnected: true,
    connectedAt: now(),
    telegramToken: token.token,
    telegramTokenUsedAt: now(),
  };

  await db.ref(`tenants/${tenantId}/public/queues/${q.key}`).update(updates);

  await db.ref(`telegramChatIndex/${chatId}`).set({
    tenantId,
    queueKey: q.key,
    connectedAt: now(),
    slug: token.slug || '',
  });

  await db.ref(`tenants/${tenantId}/notifications/performed`).push({
    timestamp: now(),
    tenantId,
    queueKey: q.key,
    queueId: q.data.queueId || '',
    queueNumber: q.data.queueNumber || '',
    chatId,
    token: token.token,
    messageType: 'telegram_connected',
    source: 'telegramWebhook',
  });

  // mark token used everywhere
  const paths = [
    `telegramTokens/${token.token}`,
    `tenants/${tenantId}/telegramTokens/${token.token}`,
    `tenants/${tenantId}/integrations/telegram/tokens/${token.token}`,
  ];

  for (const p of paths) {
    await db.ref(p).update({
      used: true,
      usedAt: now(),
      chatId,
    });
  }

  return { queue: q, tenantId };
}

/* ================= STATUS ================= */

async function getStatus(db, chatId) {
  const idx = await db.ref(`telegramChatIndex/${chatId}`).get();
  if (!idx.exists()) return null;

  const { tenantId, queueKey } = idx.val();
  const q = await db.ref(`tenants/${tenantId}/public/queues/${queueKey}`).get();

  if (!q.exists()) return null;

  return { tenantId, queueKey, data: q.val() };
}

/* ================= HANDLER ================= */

exports.handler = async (event) => {
  const db = adminInit();
  const body = JSON.parse(event.body || '{}');

  const msg = body.message;
  if (!msg) return { statusCode: 200 };

  const chatId = msg.chat.id;
  const text = safe(msg.text);

  /* ===== /help ===== */
  if (text.startsWith('/help')) {
    await send(chatId,
`💡 <b>QueueJoy Help</b>

📊 /status — Check your queue
🔗 Connect via your status page

🎯 You'll receive:
• Turn alerts
• Promotions
• Important updates

Open your QueueJoy page and tap <b>Connect Telegram</b> to begin.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Check Status', callback_data: 'status' }],
          [{ text: '🌐 Open QueueJoy', url: EXPLORE_URL }],
        ],
      },
    });
    return { statusCode: 200 };
  }

  /* ===== /status ===== */
  if (text.startsWith('/status')) {
    const s = await getStatus(db, chatId);

    if (!s) {
      await send(chatId,
`🔍 No active ticket found.

Please open your QueueJoy page and tap <b>Connect Telegram</b>.`);
      return { statusCode: 200 };
    }

    const counter = await getCounterName(db, s.tenantId, s.data, {});
    const num = s.data.queueNumber || s.data.queueId;

    await send(chatId,
`📊 <b>Your Queue Status</b>

🎫 Ticket: <b>${num}</b>
🪑 Counter: <b>${counter}</b>
📌 Status: <b>${safe(s.data.status, 'waiting')}</b>

🔔 We'll notify you when it's your turn!`);

    return { statusCode: 200 };
  }

  /* ===== /start ===== */
  if (text.startsWith('/start')) {
    const token = text.split(' ')[1];

    if (!token) {
      await send(chatId,
`👋 <b>Welcome to QueueJoy!</b>

To connect your ticket:

1️⃣ Open your QueueJoy status page  
2️⃣ Tap <b>Connect Telegram</b>  

🔔 You'll get:
• Turn alerts  
• Promotions  
• Important updates  

Paste your token here if you already have one.`);
      return { statusCode: 200 };
    }

    const tokenData = await getToken(db, token);
    if (!tokenData) {
      await send(chatId,
`⚠️ This link has expired.

Please go back to your QueueJoy page and tap <b>Connect Telegram</b> again.`);
      return { statusCode: 200 };
    }

    const result = await connect(db, tokenData, chatId);
    if (!result) {
      await send(chatId,
`⚠️ We couldn't find your ticket.

Please try again from your QueueJoy page.`);
      return { statusCode: 200 };
    }

    const counter = await getCounterName(db, result.tenantId, result.queue.data, tokenData);
    const num = result.queue.data.queueNumber || result.queue.data.queueId;

    await send(chatId,
`✅ <b>You're connected!</b>

🎫 Ticket: <b>${num}</b>
🪑 Counter: <b>${counter}</b>

🔔 We'll notify you here when it's your turn.

Relax — we've got you covered 😊`);

    return { statusCode: 200 };
  }

  /* ===== RAW TOKEN ===== */
  if (text.length < 100) {
    const tokenData = await getToken(db, text);
    if (tokenData) {
      const result = await connect(db, tokenData, chatId);
      if (result) {
        await send(chatId, '✅ Connected successfully!');
        return { statusCode: 200 };
      }
    }
  }

  /* ===== FALLBACK ===== */
  await send(chatId,
`👋 Welcome!

Open your QueueJoy page and tap <b>Connect Telegram</b> to link your ticket.`);

  return { statusCode: 200 };
};