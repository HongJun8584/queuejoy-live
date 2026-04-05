'use strict';

/*
  telegramWebhook.js — QueueJoy Tenant-Aware Telegram Bot
  Netlify Serverless Function

  - Token resolution checks ALL 3 paths
  - /start without token gives friendly onboarding (not failure)
  - Messages use HTML parse_mode
  - Records chatId into queue record, telegramChatIndex, telegramConnected
  - Logs notification-performed entries
  - Resolves queueNumber and counterName from actual records
  - Friendly, customer-focused language throughout
*/

const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) console.warn('telegramWebhook: BOT_TOKEN not set');

const EXPLORE_LABEL = '👉 Explore QueueJoy';
const EXPLORE_URL = process.env.EXPLORE_URL || 'https://helloqueuejoy.netlify.app';
const SITE_BASE = process.env.SITE_BASE || 'https://queuejoy.netlify.app';

/* ========== helpers ========== */

function isNonEmpty(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function safeString(v, fallback = '') {
  if (typeof v === 'string') {
    const s = v.trim();
    return s || fallback;
  }
  if (v === 0) return '0';
  return fallback;
}

function normalizeToken(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  try {
    if (t.includes('?')) {
      const u = new URL(t, 'https://example.invalid');
      if (u.searchParams.has('start')) return u.searchParams.get('start');
    }
  } catch { }
  const idx = t.indexOf('start=');
  if (idx !== -1) return t.slice(idx + 6).split('&')[0];
  return t || null;
}

function makeTicketLabel(entry, tokenRecord) {
  const candidates = [
    entry?.queueNumber,
    entry?.number,
    entry?.queueId,
    entry?.queueKey,
    tokenRecord?.queueNumber,
    tokenRecord?.queueId,
    tokenRecord?.queueKey,
  ];
  for (const c of candidates) {
    if (isNonEmpty(c)) return safeString(c);
  }
  return 'Your ticket';
}

function makeConnectedKeyboard(queueKey, slug, tenantId, queueNumber) {
  const params = new URLSearchParams();
  if (queueKey) params.set('queueId', queueKey);
  if (queueKey) params.set('queueKey', queueKey);
  if (slug) params.set('slug', slug);
  if (tenantId) params.set('tenantId', tenantId);
  if (queueNumber) params.set('queueNumber', queueNumber);

  const statusUrl = `${SITE_BASE}/status.html?${params.toString()}`;
  return {
    inline_keyboard: [
      [{ text: '📲 Open Queue Status', url: statusUrl }],
      [{ text: EXPLORE_LABEL, url: EXPLORE_URL }],
      [{ text: '📊 Check Status', callback_data: 'status' }, { text: '❓ Help', callback_data: 'help' }],
    ],
  };
}

function makeExploreKeyboard() {
  return {
    inline_keyboard: [
      [{ text: EXPLORE_LABEL, url: EXPLORE_URL }],
    ],
  };
}

/* ========== firebase-admin init ========== */

function tryInitAdmin() {
  let admin = null;
  try {
    admin = require('firebase-admin');
  } catch {
    return { ok: false, reason: 'firebase-admin-not-installed' };
  }

  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    null;
  let sa = null;
  if (raw) {
    try {
      sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      try {
        sa = JSON.parse(raw);
      } catch {
        sa = null;
      }
    }
  }

  const dbUrl =
    process.env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DB_URL ||
    process.env.FIREBASE_RTDB_URL ||
    undefined;
  try {
    if (sa)
      admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err?.message };
  }
}

/* ========== Telegram API ========== */

async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, disable_web_page_preview: true, parse_mode: 'HTML', ...extra };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: json || res.status };
    return { ok: true, data: json };
  } catch (e) {
    console.error('sendTelegram error', e);
    return { ok: false, error: String(e) };
  }
}

async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch { }
}

/* ========== Token resolution ========== */

async function resolveTokenToTenant(adminDb, token) {
  if (!adminDb || !token) return null;

  try {
    const gSnap = await adminDb.ref(`telegramTokens/${token}`).get().catch(() => null);
    if (gSnap?.exists?.()) {
      const val = gSnap.val() || {};
      const tenantId = val.tenantId || val.tenant || null;
      if (tenantId) return { tenantId, tokenRecord: val, source: 'global' };
    }
  } catch (e) {
    console.warn('resolveToken: global check failed', e?.message);
  }

  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (slugsSnap?.exists?.()) {
      const slugs = slugsSnap.val() || {};
      for (const slugKey of Object.keys(slugs)) {
        const mapping = slugs[slugKey];
        const tenantId = typeof mapping === 'string' ? mapping : mapping?.tenantId || null;
        if (!tenantId) continue;

        const intSnap = await adminDb.ref(`tenants/${tenantId}/integrations/telegram/tokens/${token}`).get().catch(() => null);
        if (intSnap?.exists?.()) {
          return { tenantId, tokenRecord: intSnap.val() || {}, source: `tenant-integrations:${tenantId}` };
        }

        const tSnap = await adminDb.ref(`tenants/${tenantId}/telegramTokens/${token}`).get().catch(() => null);
        if (tSnap?.exists?.()) {
          return { tenantId, tokenRecord: tSnap.val() || {}, source: `tenant-tokens:${tenantId}` };
        }
      }
    }
  } catch (e) {
    console.warn('resolveToken: tenant scan failed', e?.message);
  }

  return null;
}

/* ========== Queue resolution ========== */

async function resolveExactQueue(adminDb, tenantId, tokenRecord) {
  if (!adminDb || !tenantId || !tokenRecord) return null;

  const queueKey = safeString(tokenRecord.queueKey);
  const queueId = safeString(tokenRecord.queueId);
  const queueNumber = safeString(tokenRecord.queueNumber);

  const directPaths = [];
  if (queueKey) {
    directPaths.push(`tenants/${tenantId}/public/queues/${queueKey}`);
    directPaths.push(`tenants/${tenantId}/queue/${queueKey}`);
  }

  for (const p of directPaths) {
    try {
      const snap = await adminDb.ref(p).get().catch(() => null);
      if (snap?.exists?.()) {
        return { queueKey: queueKey || p.split('/').pop(), entry: snap.val() || {}, path: p, via: 'direct' };
      }
    } catch { }
  }

  const bases = [`tenants/${tenantId}/public/queues`, `tenants/${tenantId}/queue`];
  for (const base of bases) {
    try {
      const snap = await adminDb.ref(base).get().catch(() => null);
      if (!snap?.exists?.()) continue;
      const all = snap.val() || {};
      for (const [k, v] of Object.entries(all)) {
        const q = v || {};
        const matchesQueueKey = queueKey && (k === queueKey || safeString(q.queueKey) === queueKey);
        const matchesQueueId = queueId && safeString(q.queueId) === queueId;
        const matchesQueueNumber = queueNumber && safeString(q.queueNumber || q.number) === queueNumber;
        if (matchesQueueKey || matchesQueueId || matchesQueueNumber) {
          return { queueKey: k, entry: q, path: `${base}/${k}`, via: `scan:${base}` };
        }
      }
    } catch { }
  }

  return null;
}

/* ========== Counter name resolution ========== */

async function resolveCounterName(adminDb, tenantId, entry, tokenRecord) {
  const candidates = [entry?.counterName, tokenRecord?.counterName, entry?.counter, tokenRecord?.counter];
  for (const c of candidates) {
    if (isNonEmpty(c) && safeString(c) !== 'Unassigned') return safeString(c);
  }

  const counterId = safeString(entry?.counterId || tokenRecord?.counterId || entry?.counterAssigned || '');
  if (counterId && adminDb) {
    try {
      const cSnap = await adminDb.ref(`tenants/${tenantId}/counters/${counterId}`).get().catch(() => null);
      if (cSnap?.exists?.()) {
        const val = cSnap.val() || {};
        const name = val.name || val.displayName || val.label || null;
        if (isNonEmpty(name)) return safeString(name);
      }
    } catch { }
  }

  return null;
}

/* ========== Chat → tenant resolution ========== */

async function resolveChatToTenantAndEntry(adminDb, chatId) {
  if (!adminDb || !chatId) return null;

  try {
    const idxSnap = await adminDb.ref(`telegramChatIndex/${chatId}`).get().catch(() => null);
    if (idxSnap?.exists?.()) {
      const rec = idxSnap.val() || {};
      const tenantId = safeString(rec.tenantId);
      const queueKey = safeString(rec.queueKey);
      if (tenantId && queueKey) {
        for (const base of [`tenants/${tenantId}/public/queues`, `tenants/${tenantId}/queue`]) {
          const qSnap = await adminDb.ref(`${base}/${queueKey}`).get().catch(() => null);
          if (qSnap?.exists?.()) {
            return { tenantId, queueKey, entry: qSnap.val() || {}, slug: safeString(rec.slug), source: 'telegramChatIndex' };
          }
        }
      }
    }
  } catch { }

  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (!slugsSnap?.exists?.()) return null;
    const slugs = slugsSnap.val() || {};
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = typeof mapping === 'string' ? mapping : mapping?.tenantId || null;
      if (!tenantId) continue;

      for (const base of [`tenants/${tenantId}/public/queues`, `tenants/${tenantId}/queue`]) {
        try {
          const qSnap = await adminDb.ref(base).orderByChild('chatId').equalTo(chatId).get().catch(() => null);
          if (qSnap?.exists?.()) {
            const val = qSnap.val() || {};
            const firstKey = Object.keys(val)[0];
            return { tenantId, queueKey: firstKey, entry: val[firstKey] || {}, slug: slugKey, source: `chatScan:${base}` };
          }

          const tSnap = await adminDb.ref(base).orderByChild('telegramChatId').equalTo(chatId).get().catch(() => null);
          if (tSnap?.exists?.()) {
            const val = tSnap.val() || {};
            const firstKey = Object.keys(val)[0];
            return { tenantId, queueKey: firstKey, entry: val[firstKey] || {}, slug: slugKey, source: `telegramChatIdScan:${base}` };
          }
        } catch { }
      }
    }
  } catch { }

  return null;
}

/* ========== Attach chat to queue ========== */

async function attachChatToQueue(adminDb, tenantId, tokenRecord, chatId) {
  if (!tenantId || !chatId) return { ok: false, reason: 'missing' };

  const nowIso = new Date().toISOString();
  const resolvedQueue = await resolveExactQueue(adminDb, tenantId, tokenRecord);
  if (!resolvedQueue?.queueKey) {
    return { ok: false, reason: 'no-queue-match' };
  }

  const queueKey = resolvedQueue.queueKey;
  const entry = resolvedQueue.entry || {};
  const slug = safeString(tokenRecord?.slug || entry?.slug || '');

  const updatePayload = {
    chatId,
    telegramChatId: chatId,
    telegramConnected: true,
    connectedAt: nowIso,
    telegramToken: tokenRecord?.token || null,
    telegramTokenUsedAt: nowIso,
    updatedAt: nowIso,
  };

  const queuePaths = [
    `tenants/${tenantId}/public/queues/${queueKey}`,
    `tenants/${tenantId}/queue/${queueKey}`,
  ];

  for (const p of queuePaths) {
    try {
      await adminDb.ref(p).update(updatePayload);
    } catch { }
  }

  try {
    await adminDb.ref().update({
      [`telegramChatIndex/${chatId}`]: {
        tenantId,
        queueKey,
        connectedAt: nowIso,
        slug,
      },
      [`tenants/${tenantId}/telegramConnected/${chatId}`]: {
        connectedAt: nowIso,
        queueKey,
        slug,
      },
      [`tenants/${tenantId}/announcement/chatIds/${chatId}`]: true,
    });
  } catch { }

  return { ok: true, queueKey, entry, slug, via: resolvedQueue.via };
}

/* ========== Mark token used in all paths ========== */

async function markTokenUsedAllPaths(adminDb, tenantId, token, chatId) {
  const nowIso = new Date().toISOString();
  const updates = {};

  const paths = [
    `telegramTokens/${token}`,
    `tenants/${tenantId}/telegramTokens/${token}`,
    `tenants/${tenantId}/integrations/telegram/tokens/${token}`,
  ];

  for (const p of paths) {
    updates[`${p}/used`] = true;
    updates[`${p}/usedAt`] = nowIso;
    updates[`${p}/chatId`] = chatId;
  }

  try {
    await adminDb.ref().update(updates);
  } catch (e) {
    console.warn('mark token used failed', e?.message);
  }
}

/* ========== Notification-performed log ========== */

async function logNotificationPerformed(adminDb, { tenantId, queueKey, queueId, queueNumber, chatId, token, messageType, extra }) {
  if (!adminDb || !tenantId) return;

  const nowIso = new Date().toISOString();
  const logEntry = {
    timestamp: nowIso,
    tenantId,
    queueKey: queueKey || '',
    queueId: queueId || '',
    queueNumber: queueNumber || '',
    chatId: chatId || '',
    token: token || '',
    messageType: messageType || 'telegram_connected',
    source: 'telegramWebhook',
    ...(extra || {}),
  };

  try {
    const logRef = adminDb.ref(`tenants/${tenantId}/notifications/performed`);
    await logRef.push(logEntry);
  } catch (e) {
    console.warn('logNotificationPerformed failed', e?.message);
  }
}

/* ========== /status command ========== */

async function handleStatusCommand(adminDb, chatId) {
  if (!adminDb) {
    await sendTelegram(chatId, [
      '⚠️ Status lookup is temporarily unavailable.',
      '',
      'Please open your QueueJoy status page to check your position.',
    ].join('\n'), { reply_markup: makeExploreKeyboard() });
    return { statusCode: 200, body: 'OK' };
  }

  const resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
  if (resolved?.tenantId && resolved?.queueKey) {
    const ent = resolved.entry || {};
    const ticketLabel = makeTicketLabel(ent, {});
    const counterName = (await resolveCounterName(adminDb, resolved.tenantId, ent, {})) || 'Not yet assigned';
    const status = safeString(ent.status || 'waiting').toLowerCase();
    const statusEmoji =
      status === 'called' || status === 'serving' || status === 'your_turn' ? '🎉' :
        status === 'canceled' || status === 'cancelled' ? '❌' :
          status === 'completed' ? '✅' : '⏳';

    const reply = [
      '📊 <b>Your Queue Status</b>',
      '',
      `🧾 Ticket: <b>${ticketLabel}</b>`,
      `🪑 Counter: <b>${counterName}</b>`,
      `${statusEmoji} Status: <b>${status}</b>`,
      '✅ Telegram: Connected',
      '',
      '💡 We\'ll alert you here when it\'s your turn!',
    ].join('\n');

    await sendTelegram(chatId, reply, {
      reply_markup: makeConnectedKeyboard(resolved.queueKey, resolved.slug, resolved.tenantId, ticketLabel),
    });
    return { statusCode: 200, body: 'OK' };
  }

  await sendTelegram(chatId, [
    '🔍 No active queue found for this chat.',
    '',
    'To connect a new ticket:',
    '1️⃣ Open your QueueJoy status page',
    '2️⃣ Tap <b>📲 Connect Telegram</b>',
    '',
    'We\'ll link your ticket right away! 😊',
  ].join('\n'), { reply_markup: makeExploreKeyboard() });

  return { statusCode: 200, body: 'OK' };
}

/* ========== Main handler ========== */

exports.handler = async function (event) {
  try {
    if (!event || event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const init = tryInitAdmin();
    const adminDb = init.ok && init.admin ? init.admin.database() : null;
    const FIREBASE_DB_URL = (
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_RTDB_URL ||
      ''
    ).replace(/\/$/, '');

    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    /* ---------- callback_query ---------- */
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;
      await answerCallback(cb.id);

      if (cb.data === 'help') {
        await sendTelegram(chatId, [
          '💡 <b>QueueJoy Help</b>',
          '',
          '📊 /status — Check your queue position',
          '❓ /help — Show this help message',
          '',
          'To connect a new ticket, open your QueueJoy status page and tap <b>📲 Connect Telegram</b>.',
          '',
          '🔔 Once connected, you\'ll receive alerts for:',
          '• Your turn notifications',
          '• Exclusive discounts & promotions',
          '• Important updates from the venue',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      if (cb.data === 'status') {
        return await handleStatusCommand(adminDb, chatId);
      }

      return { statusCode: 200, body: 'OK' };
    }

    /* ---------- message ---------- */
    const msg = update.message || update.edited_message || null;
    const chatId = msg?.chat?.id ?? msg?.from?.id ?? null;
    if (!chatId) return { statusCode: 200, body: 'No chat id' };

    const messageText = safeString(msg?.text || msg?.caption || '');

    /* ---------- /help ---------- */
    if (messageText === '/help' || messageText.startsWith('/help@')) {
      await sendTelegram(chatId, [
        '💡 <b>QueueJoy Help</b>',
        '',
        '📊 /status — Check your queue position',
        '❓ /help — Show this help message',
        '',
        'To connect a new ticket, open your QueueJoy status page and tap <b>📲 Connect Telegram</b>.',
        '',
        '🔔 Once connected, you\'ll receive:',
        '• Turn notifications when it\'s your time',
        '• Exclusive discounts & promotions',
        '• Important updates from the venue',
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Status', callback_data: 'status' }],
            [{ text: EXPLORE_LABEL, url: EXPLORE_URL }],
          ],
        },
      });
      return { statusCode: 200, body: 'OK' };
    }

    /* ---------- /status ---------- */
    if (messageText === '/status' || messageText.startsWith('/status@')) {
      return await handleStatusCommand(adminDb, chatId);
    }

    /* ---------- /start or token ---------- */
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = safeString(startMatch[1]) || null;

      if (!token) {
        const text = [
          '👋 <b>Welcome to QueueJoy!</b>',
          '',
          'I\'m your queue assistant! I\'ll notify you right here on Telegram when it\'s your turn — so you don\'t need to keep checking your phone. 📱',
          '',
          '<b>Here\'s how to get started:</b>',
          '1️⃣ Open your QueueJoy status page',
          '2️⃣ Tap <b>📲 Connect Telegram</b>',
          '3️⃣ Your ticket will be linked automatically!',
          '',
          '💡 You can also paste your token link here if you have one.',
          '',
          '<b>Once connected, you\'ll receive:</b>',
          '🔔 Turn notifications — never miss your number',
          '🎁 Exclusive discounts & deals',
          '📢 Important updates from the venue',
          '🏷️ Special promotions just for you',
          '',
          'Sit back, relax, and let us handle the waiting! ☕',
        ].join('\n');

        await sendTelegram(chatId, text, { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    /* ---------- Token connection flow ---------- */
    if (token) {
      const normalized = normalizeToken(token);
      if (!normalized) {
        await sendTelegram(chatId, [
          'Hmm, that doesn\'t look like a valid token. 🤔',
          '',
          'No worries! Just go to your QueueJoy status page and tap <b>📲 Connect Telegram</b> to get a fresh link.',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      let resolved = null;
      if (adminDb) {
        resolved = await resolveTokenToTenant(adminDb, normalized);
      } else if (FIREBASE_DB_URL) {
        try {
          const tokenRec = await fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`)
            .then((r) => r.json())
            .catch(() => null);
          if (tokenRec) resolved = { tenantId: tokenRec.tenantId || tokenRec.tenant || null, tokenRecord: tokenRec, source: 'global-rest' };
        } catch { }
      }

      if (!resolved?.tenantId) {
        await sendTelegram(chatId, [
          'This token seems to have expired or isn\'t recognized. 😕',
          '',
          'Don\'t worry — just go back to your QueueJoy status page and tap <b>📲 Connect Telegram</b> to get a new link.',
          '',
          'It only takes a moment! 🚀',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      const tenantId = resolved.tenantId;
      const tokenRecord = resolved.tokenRecord || {};
      const slug = safeString(tokenRecord.slug || '');

      /* ---- Admin SDK connection ---- */
      if (adminDb) {
        const attach = await attachChatToQueue(adminDb, tenantId, tokenRecord, chatId);

        if (attach?.ok) {
          const nowIso = new Date().toISOString();

          await markTokenUsedAllPaths(adminDb, tenantId, normalized, chatId);

          const entry = attach.entry || {};
          const ticketLabel = makeTicketLabel(entry, tokenRecord);
          const counterName = (await resolveCounterName(adminDb, tenantId, entry, tokenRecord)) || 'your assigned counter';
          const queueNumber = safeString(
            entry.queueNumber || entry.number || tokenRecord.queueNumber || tokenRecord.queueId || ticketLabel
          );

          await logNotificationPerformed(adminDb, {
            tenantId,
            queueKey: attach.queueKey || '',
            queueId: safeString(entry.queueId || tokenRecord.queueId || ''),
            queueNumber,
            chatId,
            token: normalized,
            messageType: 'telegram_connected',
            extra: {
              counterName,
              slug: slug || attach.slug || '',
              via: attach.via,
            },
          });

          const reply = [
            '✅ <b>You\'re connected to QueueJoy!</b>',
            '',
            `🧾 Your ticket: <b>${ticketLabel || queueNumber}</b>`,
            `🪑 Counter: <b>${counterName}</b>`,
            '',
            '🔔 We\'ll send you a notification right here when your number is called.',
            '',
            'Feel free to close this chat or put your phone away — your alert will arrive automatically! 😊',
          ].join('\n');

          await sendTelegram(chatId, reply, {
            reply_markup: makeConnectedKeyboard(attach.queueKey, slug || attach.slug, tenantId, ticketLabel || queueNumber),
          });

          return { statusCode: 200, body: 'OK' };
        }

        await sendTelegram(chatId, [
          'We found your token, but couldn\'t locate the ticket just yet. 🔍',
          '',
          'This can happen if the ticket was recently created. Please go back to your QueueJoy status page and tap <b>📲 Connect Telegram</b> to try again.',
          '',
          'We\'re here to help! 💪',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });

        return { statusCode: 200, body: 'OK' };
      }

      /* ---- REST fallback connection ---- */
      if (FIREBASE_DB_URL && tokenRecord.queueKey) {
        const nowIso = new Date().toISOString();
        const queuePaths = [
          `${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/public/queues/${encodeURIComponent(tokenRecord.queueKey)}.json`,
          `${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/queue/${encodeURIComponent(tokenRecord.queueKey)}.json`,
        ];

        try {
          const patchBody = {
            chatId,
            telegramChatId: chatId,
            telegramConnected: true,
            connectedAt: nowIso,
            telegramToken: normalized,
            telegramTokenUsedAt: nowIso,
            updatedAt: nowIso,
          };

          const headers = { 'Content-Type': 'application/json' };

          await Promise.allSettled(
            queuePaths.map((p) => fetch(p, { method: 'PATCH', headers, body: JSON.stringify(patchBody) }))
          );

          await Promise.allSettled([
            fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
              method: 'PATCH', headers, body: JSON.stringify({ used: true, usedAt: nowIso, chatId }),
            }),
            fetch(`${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
              method: 'PATCH', headers, body: JSON.stringify({ used: true, usedAt: nowIso, chatId }),
            }),
            fetch(`${FIREBASE_DB_URL}/telegramChatIndex/${encodeURIComponent(chatId)}.json`, {
              method: 'PUT', headers, body: JSON.stringify({ tenantId, queueKey: tokenRecord.queueKey, connectedAt: nowIso, slug }),
            }),
            fetch(`${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/notifications/performed.json`, {
              method: 'POST', headers, body: JSON.stringify({
                timestamp: nowIso,
                tenantId,
                queueKey: tokenRecord.queueKey,
                queueId: tokenRecord.queueId || '',
                queueNumber: tokenRecord.queueNumber || tokenRecord.queueId || '',
                chatId,
                token: normalized,
                messageType: 'telegram_connected',
                source: 'telegramWebhook',
              }),
            }),
          ]);

          const ticketLabel = tokenRecord.queueNumber || tokenRecord.queueId || tokenRecord.queueKey || 'Your ticket';
          const counterName = tokenRecord.counterName || 'your assigned counter';

          await sendTelegram(chatId, [
            '✅ <b>You\'re connected to QueueJoy!</b>',
            '',
            `🧾 Your ticket: <b>${ticketLabel}</b>`,
            `🪑 Counter: <b>${counterName}</b>`,
            '',
            '🔔 We\'ll notify you when your number is called! 😊',
          ].join('\n'), { reply_markup: makeExploreKeyboard() });

          return { statusCode: 200, body: 'OK' };
        } catch (e) {
          console.error('REST attach failed', e);
        }
      }

      await sendTelegram(chatId, [
        'We\'re having a brief hiccup connecting right now. 😅',
        '',
        'Please try again in a moment, or go back to your QueueJoy status page and tap <b>📲 Connect Telegram</b>.',
      ].join('\n'), { reply_markup: makeExploreKeyboard() });
      return { statusCode: 200, body: 'OK' };
    }

    /* ---------- No token, no command — show linked queue or onboarding ---------- */
    if (adminDb) {
      const resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
      if (resolved?.tenantId && resolved?.queueKey) {
        const ent = resolved.entry || {};
        const ticketLabel = makeTicketLabel(ent, {});
        const counterName = (await resolveCounterName(adminDb, resolved.tenantId, ent, {})) || 'Not yet assigned';

        const reply = [
          'ℹ️ <b>Your Queue Status</b>',
          '',
          `🧾 Ticket: <b>${ticketLabel}</b>`,
          `🪑 Counter: <b>${counterName}</b>`,
          `📌 Status: <b>${safeString(ent.status || 'waiting')}</b>`,
          '✅ Telegram: Connected',
          '',
          '💡 We\'ll alert you when it\'s your turn!',
        ].join('\n');

        await sendTelegram(chatId, reply, {
          reply_markup: makeConnectedKeyboard(resolved.queueKey, resolved.slug, resolved.tenantId, ticketLabel),
        });
        return { statusCode: 200, body: 'OK' };
      }
    }

    await sendTelegram(chatId, [
      '👋 <b>Hi there!</b>',
      '',
      'I\'m the QueueJoy assistant! I don\'t see a ticket linked to this chat yet.',
      '',
      '<b>To connect your ticket:</b>',
      '1️⃣ Open your QueueJoy status page',
      '2️⃣ Tap <b>📲 Connect Telegram</b>',
      '',
      'Or paste the token link you received and I\'ll connect you right away! 🚀',
      '',
      'Once connected, you\'ll get turn notifications, exclusive deals, and more — all in this chat! 🎁',
    ].join('\n'), { reply_markup: makeExploreKeyboard() });
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err?.stack || err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
