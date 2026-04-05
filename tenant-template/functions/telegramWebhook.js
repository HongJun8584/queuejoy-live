'use strict';

/*
  telegramWebhook.js — QueueJoy Tenant-Aware Telegram Bot
  Netlify Serverless Function

  - Token resolution checks ALL 3 paths
  - /start without token gives helpful instructions (not failure)
  - Messages use HTML parse_mode matching notifyCounter.js style
  - Explore QueueJoy inline button on all messages
  - Tenant-aware chat→queue resolution
  - Records chatId into queue record, telegramChatIndex, telegramConnected, announcement/chatIds
  - Resolves queueNumber and counterName from actual records, never shows Unknown/Unassigned if data exists
*/

const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) console.warn('telegramWebhook: BOT_TOKEN not set');

const EXPLORE_LABEL = '👉 Explore QueueJoy';
const EXPLORE_URL = process.env.EXPLORE_URL || 'https://helloqueuejoy.netlify.app';
const SITE_BASE = process.env.SITE_BASE || 'https://queuejoy.netlify.app';

function makeHeaders() {
  return { 'Content-Type': 'application/json' };
}

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
  } catch (e) {}
  const idx = t.indexOf('start=');
  if (idx !== -1) return t.slice(idx + 6).split('&')[0];
  return t || null;
}

function normalizeStatus(status) {
  return safeString(status).toLowerCase();
}

function makeTicketLabel(entry, tokenRecord) {
  const candidates = [
    entry?.queueNumber,
    entry?.number,
    entry?.queueId,
    entry?.queueKey,
    tokenRecord?.queueNumber,
    tokenRecord?.queueId,
    tokenRecord?.queueKey
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
      [{ text: '📄 Help', callback_data: 'help' }]
    ]
  };
}

function makeExploreKeyboard() {
  return { inline_keyboard: [[{ text: EXPLORE_LABEL, url: EXPLORE_URL }]] };
}

/* ---------- firebase-admin init ---------- */
function tryInitAdmin() {
  let admin = null;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    return { ok: false, reason: 'firebase-admin-not-installed' };
  }

  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try {
      const maybe = Buffer.from(raw, 'base64').toString('utf8');
      sa = JSON.parse(maybe);
    } catch (e) {
      try {
        sa = JSON.parse(raw);
      } catch (e2) {
        sa = null;
      }
    }
  }

  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;
  try {
    if (sa) admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err?.message };
  }
}

/* ---------- Telegram helpers ---------- */
async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, disable_web_page_preview: true, parse_mode: 'HTML', ...extra };
  try {
    const res = await fetch(url, { method: 'POST', headers: makeHeaders(), body: JSON.stringify(body) });
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
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (e) {}
}

/* ---------- token resolution ---------- */
async function resolveTokenToTenant(adminDb, token) {
  if (!adminDb || !token) return null;

  // Path 1: global telegramTokens/{token}
  try {
    const gSnap = await adminDb.ref(`telegramTokens/${token}`).get().catch(() => null);
    if (gSnap && gSnap.exists && gSnap.exists()) {
      const val = gSnap.val() || {};
      const tenantId = val.tenantId || val.tenant || null;
      if (tenantId) return { tenantId, tokenRecord: val, source: 'global' };
    }
  } catch (e) {
    console.warn('resolveToken: global check failed', e?.message);
  }

  // Path 2 and 3: tenant token paths
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (slugsSnap && slugsSnap.exists && slugsSnap.exists()) {
      const slugs = slugsSnap.val() || {};
      for (const slugKey of Object.keys(slugs)) {
        const mapping = slugs[slugKey];
        const tenantId = (typeof mapping === 'string') ? mapping : (mapping?.tenantId || null);
        if (!tenantId) continue;

        const intSnap = await adminDb.ref(`tenants/${tenantId}/integrations/telegram/tokens/${token}`).get().catch(() => null);
        if (intSnap && intSnap.exists && intSnap.exists()) {
          return { tenantId, tokenRecord: intSnap.val() || {}, source: `tenant-integrations:${tenantId}` };
        }

        const tSnap = await adminDb.ref(`tenants/${tenantId}/telegramTokens/${token}`).get().catch(() => null);
        if (tSnap && tSnap.exists && tSnap.exists()) {
          return { tenantId, tokenRecord: tSnap.val() || {}, source: `tenant-tokens:${tenantId}` };
        }
      }
    }
  } catch (e) {
    console.warn('resolveToken: tenant scan failed', e?.message);
  }

  return null;
}

/* ---------- exact queue resolution ---------- */
async function resolveExactQueue(adminDb, tenantId, tokenRecord) {
  if (!adminDb || !tenantId || !tokenRecord) return null;

  const queueKey = safeString(tokenRecord.queueKey);
  const queueId = safeString(tokenRecord.queueId);
  const queueNumber = safeString(tokenRecord.queueNumber);

  const directPaths = [];
  if (queueKey) {
    directPaths.push(`tenants/${tenantId}/queue/${queueKey}`);
    directPaths.push(`tenants/${tenantId}/public/queues/${queueKey}`);
  }

  for (const p of directPaths) {
    try {
      const snap = await adminDb.ref(p).get().catch(() => null);
      if (snap && snap.exists && snap.exists()) {
        return { queueKey: queueKey || p.split('/').pop(), entry: snap.val() || {}, path: p, via: 'direct' };
      }
    } catch (e) {}
  }

  const bases = [
    `tenants/${tenantId}/queue`,
    `tenants/${tenantId}/public/queues`
  ];

  for (const base of bases) {
    try {
      const snap = await adminDb.ref(base).get().catch(() => null);
      if (!snap || !snap.exists || !snap.exists()) continue;

      const all = snap.val() || {};
      for (const [k, v] of Object.entries(all)) {
        const q = v || {};
        const visibleLabel = safeString(q.queueNumber || q.number || q.queueId || k);
        const matchesQueueKey = queueKey && (k === queueKey || safeString(q.queueKey) === queueKey);
        const matchesQueueId = queueId && safeString(q.queueId) === queueId;
        const matchesQueueNumber = queueNumber && safeString(q.queueNumber || q.number) === queueNumber;
        const matchesLabel = queueNumber && visibleLabel === queueNumber;

        if (matchesQueueKey || matchesQueueId || matchesQueueNumber || matchesLabel) {
          return { queueKey: k, entry: q, path: `${base}/${k}`, via: `scan:${base}` };
        }
      }
    } catch (e) {}
  }

  return null;
}

/* ---------- counter name ---------- */
async function resolveCounterName(adminDb, tenantId, entry, tokenRecord) {
  const directCandidates = [
    entry?.counterName,
    tokenRecord?.counterName,
    entry?.counter,
    tokenRecord?.counter
  ];

  for (const c of directCandidates) {
    if (isNonEmpty(c) && safeString(c) !== 'Unassigned') return safeString(c);
  }

  const counterId = safeString(entry?.counterId || tokenRecord?.counterId || entry?.counterAssigned || '');
  if (counterId && adminDb) {
    try {
      const cSnap = await adminDb.ref(`tenants/${tenantId}/counters/${counterId}`).get().catch(() => null);
      if (cSnap && cSnap.exists && cSnap.exists()) {
        const val = cSnap.val() || {};
        const name = val.name || val.displayName || val.label || null;
        if (isNonEmpty(name)) return safeString(name);
      }
    } catch (e) {}
  }

  return null;
}

/* ---------- chat resolution ---------- */
async function resolveChatToTenantAndEntry(adminDb, chatId) {
  if (!adminDb || !chatId) return null;

  // Fast path: telegramChatIndex/{chatId}
  try {
    const idxSnap = await adminDb.ref(`telegramChatIndex/${chatId}`).get().catch(() => null);
    if (idxSnap && idxSnap.exists && idxSnap.exists()) {
      const rec = idxSnap.val() || {};
      const tenantId = safeString(rec.tenantId);
      const queueKey = safeString(rec.queueKey);
      if (tenantId && queueKey) {
        const qSnap = await adminDb.ref(`tenants/${tenantId}/queue/${queueKey}`).get().catch(() => null);
        if (qSnap && qSnap.exists && qSnap.exists()) {
          return { tenantId, queueKey, entry: qSnap.val() || {}, slug: safeString(rec.slug, ''), source: 'telegramChatIndex' };
        }
        const pSnap = await adminDb.ref(`tenants/${tenantId}/public/queues/${queueKey}`).get().catch(() => null);
        if (pSnap && pSnap.exists && pSnap.exists()) {
          return { tenantId, queueKey, entry: pSnap.val() || {}, slug: safeString(rec.slug, ''), source: 'telegramChatIndex-public' };
        }
      }
    }
  } catch (e) {}

  // Fallback: scan tenant queues for chatId
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (!slugsSnap || !slugsSnap.exists || !slugsSnap.exists()) return null;
    const slugs = slugsSnap.val() || {};
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = (typeof mapping === 'string') ? mapping : (mapping?.tenantId || null);
      if (!tenantId) continue;

      for (const base of [`tenants/${tenantId}/queue`, `tenants/${tenantId}/public/queues`]) {
        try {
          const qSnap = await adminDb.ref(base).orderByChild('chatId').equalTo(chatId).get().catch(() => null);
          if (qSnap && qSnap.exists && qSnap.exists()) {
            const val = qSnap.val() || {};
            const firstKey = Object.keys(val)[0];
            return { tenantId, queueKey: firstKey, entry: val[firstKey] || {}, slug: slugKey, source: `chatScan:${base}` };
          }

          const tSnap = await adminDb.ref(base).orderByChild('telegramChatId').equalTo(chatId).get().catch(() => null);
          if (tSnap && tSnap.exists && tSnap.exists()) {
            const val = tSnap.val() || {};
            const firstKey = Object.keys(val)[0];
            return { tenantId, queueKey: firstKey, entry: val[firstKey] || {}, slug: slugKey, source: `telegramChatIdScan:${base}` };
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  return null;
}

/* ---------- attach chat to queue ---------- */
async function attachChatToQueue(adminDb, tenantId, tokenRecord, chatId) {
  if (!tenantId || !chatId) return { ok: false, reason: 'missing' };

  const nowIso = new Date().toISOString();

  const resolvedQueue = await resolveExactQueue(adminDb, tenantId, tokenRecord);
  if (!resolvedQueue || !resolvedQueue.queueKey) {
    return { ok: false, reason: 'no-queue-match' };
  }

  const queueKey = resolvedQueue.queueKey;
  const entry = resolvedQueue.entry || {};
  const queuePaths = [
    `tenants/${tenantId}/queue/${queueKey}`,
    `tenants/${tenantId}/public/queues/${queueKey}`
  ];

  const updatePayload = {
    chatId: chatId,
    telegramChatId: chatId,
    telegramConnected: true,
    connectedAt: nowIso,
    telegramToken: tokenRecord?.token || null,
    telegramTokenUsedAt: nowIso,
    updatedAt: nowIso
  };

  try {
    await adminDb.ref().update({
      [`telegramChatIndex/${chatId}`]: {
        tenantId,
        queueKey,
        connectedAt: nowIso,
        slug: safeString(tokenRecord?.slug || '', '')
      },
      [`tenants/${tenantId}/telegramConnected/${chatId}`]: {
        connectedAt: nowIso,
        queueKey,
        slug: safeString(tokenRecord?.slug || '', '')
      },
      [`tenants/${tenantId}/announcement/chatIds/${chatId}`]: true,
    });
  } catch (e) {}

  for (const p of queuePaths) {
    try {
      await adminDb.ref(p).update(updatePayload);
    } catch (e) {}
  }

  return { ok: true, queueKey, entry, via: resolvedQueue.via };
}

/* ---------- token mark used ---------- */
async function markTokenUsedAllPaths(adminDb, tenantId, token, chatId) {
  const nowIso = new Date().toISOString();
  const updates = {};
  updates[`telegramTokens/${token}/used`] = true;
  updates[`telegramTokens/${token}/usedAt`] = nowIso;
  updates[`telegramTokens/${token}/chatId`] = chatId;

  updates[`tenants/${tenantId}/telegramTokens/${token}/used`] = true;
  updates[`tenants/${tenantId}/telegramTokens/${token}/usedAt`] = nowIso;
  updates[`tenants/${tenantId}/telegramTokens/${token}/chatId`] = chatId;

  updates[`tenants/${tenantId}/integrations/telegram/tokens/${token}/used`] = true;
  updates[`tenants/${tenantId}/integrations/telegram/tokens/${token}/usedAt`] = nowIso;
  updates[`tenants/${tenantId}/integrations/telegram/tokens/${token}/chatId`] = chatId;

  try {
    await adminDb.ref().update(updates);
  } catch (e) {
    console.warn('mark token used failed', e?.message);
  }
}

/* ---------- /status ---------- */
async function handleStatusCommand(adminDb, chatId) {
  if (!adminDb) {
    await sendTelegram(chatId, '⚠️ Status lookup is temporarily unavailable. Please open your QueueJoy status page.', {
      reply_markup: makeExploreKeyboard()
    });
    return { statusCode: 200, body: 'OK' };
  }

  const resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
  if (resolved && resolved.tenantId && resolved.queueKey) {
    const ent = resolved.entry || {};
    const ticketLabel = makeTicketLabel(ent, {});
    const counterName = await resolveCounterName(adminDb, resolved.tenantId, ent, {}) || 'Not yet assigned';
    const status = normalizeStatus(ent.status || 'waiting');
    const statusEmoji =
      status === 'called' || status === 'serving' || status === 'your_turn' ? '🎉' :
      status === 'canceled' || status === 'cancelled' ? '❌' :
      status === 'completed' ? '✅' : '⏳';

    const reply = [
      '📊 <b>Your Queue Status</b>',
      '',
      `🧾 Number: <b>${ticketLabel}</b>`,
      `🪑 Counter: <b>${counterName}</b>`,
      `${statusEmoji} Status: <b>${status}</b>`,
      `✅ Telegram: Connected`,
    ].join('\n');

    await sendTelegram(chatId, reply, {
      reply_markup: makeConnectedKeyboard(resolved.queueKey, resolved.slug, resolved.tenantId, ticketLabel)
    });
    return { statusCode: 200, body: 'OK' };
  }

  await sendTelegram(chatId, [
    '🔍 No active queue found for this chat.',
    '',
    'To connect a new ticket, open your QueueJoy status page and tap <b>📲 Connect Telegram</b>.'
  ].join('\n'), { reply_markup: makeExploreKeyboard() });

  return { statusCode: 200, body: 'OK' };
}

/* ---------- main handler ---------- */
exports.handler = async function (event) {
  try {
    if (!event || event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const init = tryInitAdmin();
    const adminDb = init.ok && init.admin ? init.admin.database() : null;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');

    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    // callback_query
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
          'To connect a new ticket, open your QueueJoy status page and tap <b>Connect Telegram</b>.',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      if (cb.data === 'status') {
        return await handleStatusCommand(adminDb, chatId);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // messages
    const msg = update.message || update.edited_message || null;
    const chatId = msg?.chat?.id ?? msg?.from?.id ?? null;
    if (!chatId) return { statusCode: 200, body: 'No chat id' };

    const messageText = safeString(msg?.text || msg?.caption || '', '');

    // /help
    if (messageText === '/help' || messageText.startsWith('/help@')) {
      await sendTelegram(chatId, [
        '💡 <b>QueueJoy Help</b>',
        '',
        '📊 /status — Check your queue position',
        '❓ /help — Show this help message',
        '',
        'To connect a new ticket, open your QueueJoy status page and tap <b>Connect Telegram</b>.',
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Status', callback_data: 'status' }],
            [{ text: EXPLORE_LABEL, url: EXPLORE_URL }]
          ]
        }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // /status
    if (messageText === '/status' || messageText.startsWith('/status@')) {
      return await handleStatusCommand(adminDb, chatId);
    }

    // /start <token> or raw token
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = safeString(startMatch[1], '') || null;
      if (!token) {
        const text = [
          '👋 <b>Welcome to QueueJoy!</b>',
          '',
          'I help you get notified when your queue number is called — no need to keep the browser open!',
          '',
          '<b>How to connect:</b>',
          '1️⃣ Open your QueueJoy status page',
          '2️⃣ Tap <b>📲 Connect Telegram</b>',
          '3️⃣ Your ticket will be linked automatically',
          '',
          '💡 You can also paste your token link here.',
          '',
          'Once connected, you’ll receive:',
          '• 🔔 Turn notifications',
          '• 🎁 Exclusive discounts',
          '• 📢 Important updates',
          '• 🏷️ Promotions',
        ].join('\n');

        await sendTelegram(chatId, text, { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    if (token) {
      const normalized = normalizeToken(token);
      if (!normalized) {
        await sendTelegram(chatId, '⚠️ That does not look like a valid token. Please open your QueueJoy status page and tap <b>Connect Telegram</b> to get a fresh link.', {
          reply_markup: makeExploreKeyboard()
        });
        return { statusCode: 200, body: 'OK' };
      }

      let resolved = null;
      if (adminDb) {
        resolved = await resolveTokenToTenant(adminDb, normalized);
      } else if (FIREBASE_DB_URL) {
        try {
          const tokenRec = await fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`)
            .then(r => r.json())
            .catch(() => null);
          if (tokenRec) resolved = { tenantId: tokenRec.tenantId || tokenRec.tenant || null, tokenRecord: tokenRec, source: 'global-rest' };
        } catch (e) {}
      }

      if (!resolved || !resolved.tenantId) {
        await sendTelegram(chatId, [
          '⚠️ This token has expired or could not be found.',
          '',
          'No worries — go back to your QueueJoy status page and tap <b>📲 Connect Telegram</b> to get a fresh link.'
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      const tenantId = resolved.tenantId;
      const tokenRecord = resolved.tokenRecord || {};
      const slug = safeString(tokenRecord.slug || '', '');

      if (adminDb) {
        const attach = await attachChatToQueue(adminDb, tenantId, tokenRecord, chatId);

        if (attach && attach.ok) {
          const nowIso = new Date().toISOString();

          await markTokenUsedAllPaths(adminDb, tenantId, normalized, chatId);

          // ensure indexes exist even if earlier update partial
          try {
            await adminDb.ref(`telegramChatIndex/${chatId}`).set({
              tenantId,
              queueKey: attach.queueKey || null,
              connectedAt: nowIso,
              slug: slug || null
            });
          } catch (e) {}

          try {
            await adminDb.ref(`tenants/${tenantId}/telegramConnected/${chatId}`).set({
              connectedAt: nowIso,
              queueKey: attach.queueKey || null,
              slug: slug || null
            });
          } catch (e) {}

          try {
            await adminDb.ref(`tenants/${tenantId}/announcement/chatIds/${chatId}`).set(true);
          } catch (e) {}

          const entry = attach.entry || {};
          const ticketLabel = makeTicketLabel(entry, tokenRecord);
          const counterName = await resolveCounterName(adminDb, tenantId, entry, tokenRecord) || 'your assigned counter';
          const queueNumber = safeString(entry.queueNumber || entry.number || tokenRecord.queueNumber || tokenRecord.queueId || ticketLabel);
          const reply = [
            '✅ <b>Connected to QueueJoy!</b>',
            '',
            `🧾 Your number: <b>${ticketLabel || queueNumber}</b>`,
            `🪑 Counter: <b>${counterName}</b>`,
            '',
            '🔔 We will notify you via this chat when your number is called.',
            '',
            'You can close this chat or even your phone — notifications arrive automatically!'
          ].join('\n');

          await sendTelegram(chatId, reply, {
            reply_markup: makeConnectedKeyboard(attach.queueKey, slug, tenantId, ticketLabel || queueNumber)
          });

          return { statusCode: 200, body: 'OK' };
        }

        await sendTelegram(chatId, [
          '⚠️ We found your token but could not locate the queue ticket.',
          '',
          'Please go back to your QueueJoy status page and tap <b>📲 Connect Telegram</b> again.'
        ].join('\n'), { reply_markup: makeExploreKeyboard() });

        return { statusCode: 200, body: 'OK' };
      }

      // REST fallback
      if (FIREBASE_DB_URL && tokenRecord.queueKey) {
        const nowIso = new Date().toISOString();
        const queuePath = `${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/queue/${encodeURIComponent(tokenRecord.queueKey)}.json`;
        const publicQueuePath = `${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/public/queues/${encodeURIComponent(tokenRecord.queueKey)}.json`;

        try {
          const patchBody = {
            chatId,
            telegramChatId: chatId,
            telegramConnected: true,
            connectedAt: nowIso,
            telegramToken: normalized,
            telegramTokenUsedAt: nowIso,
            updatedAt: nowIso
          };

          await fetch(queuePath, { method: 'PATCH', headers: makeHeaders(), body: JSON.stringify(patchBody) });
          await fetch(publicQueuePath, { method: 'PATCH', headers: makeHeaders(), body: JSON.stringify(patchBody) }).catch(() => {});

          await Promise.allSettled([
            fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
              method: 'PATCH',
              headers: makeHeaders(),
              body: JSON.stringify({ used: true, usedAt: nowIso, chatId })
            }),
            fetch(`${FIREBASE_DB_URL}/tenants/${encodeURIComponent(tenantId)}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
              method: 'PATCH',
              headers: makeHeaders(),
              body: JSON.stringify({ used: true, usedAt: nowIso, chatId })
            }),
            fetch(`${FIREBASE_DB_URL}/telegramChatIndex/${encodeURIComponent(chatId)}.json`, {
              method: 'PUT',
              headers: makeHeaders(),
              body: JSON.stringify({ tenantId, queueKey: tokenRecord.queueKey, connectedAt: nowIso, slug })
            }),
          ]);

          const ticketLabel = tokenRecord.queueNumber || tokenRecord.queueId || tokenRecord.queueKey || 'Your ticket';
          const counterName = tokenRecord.counterName || 'your assigned counter';

          await sendTelegram(chatId, [
            '✅ <b>Connected to QueueJoy!</b>',
            '',
            `🧾 Your number: <b>${ticketLabel}</b>`,
            `🪑 Counter: <b>${counterName}</b>`,
            '',
            '🔔 We will notify you when your number is called!'
          ].join('\n'), { reply_markup: makeExploreKeyboard() });

          return { statusCode: 200, body: 'OK' };
        } catch (e) {
          console.error('REST attach failed', e);
        }
      }

      await sendTelegram(chatId, 'Server cannot complete connection right now. Please try again in a moment.', {
        reply_markup: makeExploreKeyboard()
      });
      return { statusCode: 200, body: 'OK' };
    }

    // no token, no command — show linked queue if available
    if (adminDb) {
      const resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
      if (resolved && resolved.tenantId && resolved.queueKey) {
        const ent = resolved.entry || {};
        const ticketLabel = makeTicketLabel(ent, {});
        const counterName = await resolveCounterName(adminDb, resolved.tenantId, ent, {}) || 'Not yet assigned';

        const reply = [
          'ℹ️ <b>Your Queue Status</b>',
          '',
          `🧾 Number: <b>${ticketLabel}</b>`,
          `🪑 Counter: <b>${counterName}</b>`,
          `📌 Status: <b>${safeString(ent.status || 'waiting')}</b>`,
          `✅ Telegram: Connected`
        ].join('\n');

        await sendTelegram(chatId, reply, {
          reply_markup: makeConnectedKeyboard(resolved.queueKey, resolved.slug, resolved.tenantId, ticketLabel)
        });
        return { statusCode: 200, body: 'OK' };
      }
    }

    const connectInstructions = [
      '👋 <b>Hi there!</b>',
      '',
      'I could not find a queue linked to this chat yet.',
      '',
      '<b>To connect your ticket:</b>',
      '1️⃣ Open your QueueJoy status page',
      '2️⃣ Tap <b>📲 Connect Telegram</b>',
      '',
      'Or paste the token link you received and I will connect you right away!'
    ].join('\n');

    await sendTelegram(chatId, connectInstructions, { reply_markup: makeExploreKeyboard() });
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err && (err.stack || err));
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};