'use strict';

/*
  telegramWebhook.js — QueueJoy Tenant-Aware Telegram Bot (FIXED)
  - Token resolution checks ALL 3 paths
  - /start without token gives helpful instructions (not failure)
  - Messages use HTML parse_mode matching notifyCounter.js style
  - Explore QueueJoy inline button on all messages
  - Tenant-aware chat→queue resolution
*/

const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) console.warn('telegramWebhook: BOT_TOKEN not set');

const EXPLORE_LABEL = '👉 Explore QueueJoy';
const EXPLORE_URL = process.env.EXPLORE_URL || 'https://helloqueuejoy.netlify.app';
const SITE_BASE = process.env.SITE_BASE || 'https://queuejoy.netlify.app';

function makeHeaders() { return { 'Content-Type': 'application/json' }; }

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

/* ---------- firebase-admin init ---------- */
function tryInitAdmin() {
  let admin = null;
  try { admin = require('firebase-admin'); } catch (e) { return { ok: false, reason: 'firebase-admin-not-installed' }; }
  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try { const maybe = Buffer.from(raw, 'base64').toString('utf8'); sa = JSON.parse(maybe); } catch (e) { try { sa = JSON.parse(raw); } catch (e2) { sa = null; } }
  }
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;
  try {
    if (sa) admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) { return { ok: false, reason: 'init_failed', detail: err?.message }; }
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
  } catch (e) { console.error('sendTelegram error', e); return { ok: false, error: String(e) }; }
}

async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  try { await fetch(url, { method: 'POST', headers: makeHeaders(), body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }) }); } catch (e) {}
}

function makeExploreKeyboard() {
  return {
    inline_keyboard: [
      [{ text: EXPLORE_LABEL, url: EXPLORE_URL }]
    ]
  };
}

function makeConnectedKeyboard(queueKey) {
  const statusUrl = `${SITE_BASE}/status.html?queueId=${encodeURIComponent(queueKey || '')}`;
  return {
    inline_keyboard: [
      [{ text: '📲 Open Queue Status', url: statusUrl }],
      [{ text: EXPLORE_LABEL, url: EXPLORE_URL }],
      [{ text: '📄 Help', callback_data: 'help' }]
    ]
  };
}

/* ---------- Token resolution — checks ALL 3 paths ---------- */
async function resolveTokenToTenant(adminDb, token) {
  // Path 1: Global telegramTokens/{token}
  try {
    const gSnap = await adminDb.ref(`telegramTokens/${token}`).get().catch(() => null);
    if (gSnap && gSnap.exists && gSnap.exists()) {
      const val = gSnap.val();
      const tenantId = val.tenantId || val.tenant || null;
      if (tenantId) return { tenantId, tokenRecord: val, source: 'global' };
      // Global record exists but no tenant — try to find via scan below
    }
  } catch (e) { console.warn('resolveToken: global check failed', e?.message); }

  // Path 2 & 3: Scan slugs → check tenant paths
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (slugsSnap && slugsSnap.exists && slugsSnap.exists()) {
      const slugs = slugsSnap.val();
      for (const slugKey of Object.keys(slugs)) {
        const mapping = slugs[slugKey];
        const tenantId = (typeof mapping === 'string') ? mapping : (mapping?.tenantId || null);
        if (!tenantId) continue;

        // Check tenants/{tenantId}/integrations/telegram/tokens/{token}
        const intSnap = await adminDb.ref(`tenants/${tenantId}/integrations/telegram/tokens/${token}`).get().catch(() => null);
        if (intSnap && intSnap.exists && intSnap.exists()) {
          return { tenantId, tokenRecord: intSnap.val(), source: `tenant-integrations:${tenantId}` };
        }

        // Check tenants/{tenantId}/telegramTokens/{token}
        const tSnap = await adminDb.ref(`tenants/${tenantId}/telegramTokens/${token}`).get().catch(() => null);
        if (tSnap && tSnap.exists && tSnap.exists()) {
          return { tenantId, tokenRecord: tSnap.val(), source: `tenant-tokens:${tenantId}` };
        }
      }
    }
  } catch (e) { console.warn('resolveToken: tenant scan failed', e?.message); }

  return null;
}

/* ---------- Chat → tenant/queue resolution ---------- */
async function resolveChatToTenantAndEntry(adminDb, chatId) {
  if (!adminDb || !chatId) return null;

  // Fast path: global index
  try {
    const idxSnap = await adminDb.ref(`telegramChatIndex/${chatId}`).get().catch(() => null);
    if (idxSnap && idxSnap.exists && idxSnap.exists()) {
      const rec = idxSnap.val();
      if (rec?.tenantId && rec?.queueKey) {
        const qeSnap = await adminDb.ref(`tenants/${rec.tenantId}/queue/${rec.queueKey}`).get().catch(() => null);
        if (qeSnap && qeSnap.exists && qeSnap.exists()) {
          return { tenantId: rec.tenantId, queueKey: rec.queueKey, entry: qeSnap.val(), source: 'index' };
        }
      }
    }
  } catch (e) {}

  // Fallback: scan slugs
  try {
    const slugsSnap = await adminDb.ref('slugs').get().catch(() => null);
    if (!slugsSnap || !slugsSnap.exists || !slugsSnap.exists()) return null;
    const slugs = slugsSnap.val();
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = (typeof mapping === 'string') ? mapping : (mapping?.tenantId || null);
      if (!tenantId) continue;
      try {
        const qSnap = await adminDb.ref(`tenants/${tenantId}/queue`).orderByChild('chatId').equalTo(chatId).get().catch(() => null);
        if (qSnap && qSnap.exists && qSnap.exists()) {
          const val = qSnap.val();
          const firstKey = Object.keys(val)[0];
          return { tenantId, queueKey: firstKey, entry: val[firstKey], source: `tenantScan:${tenantId}` };
        }
      } catch (e) {}
    }
  } catch (e) {}

  return null;
}

/* ---------- Attach chat to queue ---------- */
async function attachChatToQueue(adminDb, tenantId, tokenRecord, chatId) {
  if (!tenantId || !chatId) return { ok: false, reason: 'missing' };

  // queueKey is the primary identifier (= queueId = database key)
  const queueKey = tokenRecord?.queueKey || tokenRecord?.queueId || null;

  if (queueKey) {
    const queueRef = adminDb.ref(`tenants/${tenantId}/queue/${queueKey}`);
    const snap = await queueRef.get().catch(() => null);

    if (snap && snap.exists && snap.exists()) {
      await queueRef.update({
        chatId: chatId,
        telegramConnected: true,
        connectedAt: new Date().toISOString()
      });
      return { ok: true, queueKey, entry: snap.val(), via: 'token.queueKey' };
    }
    // Queue key provided but entry doesn't exist — still try to create the link
    await queueRef.update({
      chatId: chatId,
      telegramConnected: true,
      connectedAt: new Date().toISOString()
    });
    return { ok: true, queueKey, entry: null, via: 'token.queueKey.created' };
  }

  // No queueKey — try scanning by queueId field
  if (tokenRecord?.queueId) {
    try {
      const qSnap = await adminDb.ref(`tenants/${tenantId}/queue`).orderByChild('queueId').equalTo(tokenRecord.queueId).get().catch(() => null);
      if (qSnap && qSnap.exists && qSnap.exists()) {
        const val = qSnap.val();
        const firstKey = Object.keys(val)[0];
        await adminDb.ref(`tenants/${tenantId}/queue/${firstKey}`).update({
          chatId: chatId,
          telegramConnected: true,
          connectedAt: new Date().toISOString()
        });
        return { ok: true, queueKey: firstKey, entry: val[firstKey], via: 'scan.queueId' };
      }
    } catch (e) {}
  }

  return { ok: false, reason: 'no-queue-match' };
}

/* ---------- Main handler ---------- */
exports.handler = async function (event) {
  try {
    if (!event || event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const init = tryInitAdmin();
    const adminOk = init.ok && init.admin;
    const adminDb = adminOk ? init.admin.database() : null;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');

    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

    // Handle callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;
      await answerCallback(cb.id);

      if (cb.data === 'help') {
        await sendTelegram(chatId, '💡 <b>Need a Hand?</b>\n\nCheck your number and counter with /status anytime.', { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
      if (cb.data === 'status') {
        return await handleStatusCommand(adminDb, FIREBASE_DB_URL, chatId);
      }
      return { statusCode: 200, body: 'OK' };
    }

    // Handle messages
    const msg = update.message || update.edited_message || null;
    const userChatId = msg?.chat?.id ?? msg?.from?.id ?? null;
    if (!userChatId) return { statusCode: 200, body: 'No chat id' };
    const messageText = (msg?.text || msg?.caption || '').trim();

    // /help
    if (messageText === '/help' || messageText.startsWith('/help@')) {
      await sendTelegram(userChatId, '💡 <b>Need a Hand?</b>\n\nCheck your number and counter with /status anytime.', {
        reply_markup: { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }], [{ text: EXPLORE_LABEL, url: EXPLORE_URL }]] }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // /status
    if (messageText === '/status' || messageText.startsWith('/status@')) {
      return await handleStatusCommand(adminDb, FIREBASE_DB_URL, userChatId);
    }

    // Parse /start <token> or raw token
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
      if (!token) {
        // /start with NO token — friendly instructions, NOT failure
        const text = [
          '👋 <b>Welcome to QueueJoy!</b>',
          '',
          'To connect your queue ticket:',
          '1. Open your QueueJoy status page',
          '2. Tap <b>Connect Telegram</b>',
          '3. It will automatically link your ticket here',
          '',
          'Or paste your token link here and I\'ll connect you.',
        ].join('\n');
        await sendTelegram(userChatId, text, { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    if (token) {
      const normalized = normalizeToken(token);
      if (!normalized) {
        await sendTelegram(userChatId, '⚠️ Invalid token format. Please paste the token link or tap <b>Connect Telegram</b> on your status page.');
        return { statusCode: 200, body: 'OK' };
      }

      // Resolve token → tenant
      let resolved = null;
      if (adminDb) {
        resolved = await resolveTokenToTenant(adminDb, normalized);
      } else if (FIREBASE_DB_URL) {
        // REST fallback: check global path
        try {
          const tokenRec = await fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`).then(r => r.json()).catch(() => null);
          if (tokenRec) resolved = { tenantId: tokenRec.tenantId || tokenRec.tenant || null, tokenRecord: tokenRec, source: 'global-rest' };
        } catch (e) {}
      }

      if (!resolved || !resolved.tenantId) {
        await sendTelegram(userChatId, [
          '⚠️ Could not resolve this token.',
          '',
          'Please open your QueueJoy status page and tap <b>Connect Telegram</b> to generate a fresh link.',
        ].join('\n'), { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }

      const tenantId = resolved.tenantId;
      const tokenRecord = resolved.tokenRecord || {};

      if (adminDb) {
        const attach = await attachChatToQueue(adminDb, tenantId, tokenRecord, userChatId);

        if (attach && attach.ok) {
          // Mark token used in all paths (best effort)
          const nowIso = new Date().toISOString();
          const tokenUpdates = {};
          tokenUpdates[`telegramTokens/${normalized}/used`] = true;
          tokenUpdates[`telegramTokens/${normalized}/usedAt`] = nowIso;
          tokenUpdates[`telegramTokens/${normalized}/chatId`] = userChatId;
          tokenUpdates[`tenants/${tenantId}/telegramTokens/${normalized}/used`] = true;
          tokenUpdates[`tenants/${tenantId}/telegramTokens/${normalized}/usedAt`] = nowIso;
          tokenUpdates[`tenants/${tenantId}/telegramTokens/${normalized}/chatId`] = userChatId;
          tokenUpdates[`tenants/${tenantId}/integrations/telegram/tokens/${normalized}/used`] = true;
          tokenUpdates[`tenants/${tenantId}/integrations/telegram/tokens/${normalized}/usedAt`] = nowIso;
          try { await adminDb.ref().update(tokenUpdates); } catch (e) { console.warn('mark token used failed', e?.message); }

          // Update tenant indexes
          try { await adminDb.ref(`tenants/${tenantId}/telegramConnected/${userChatId}`).set({ connectedAt: nowIso, queueKey: attach.queueKey || null }); } catch (e) {}
          try { await adminDb.ref(`tenants/${tenantId}/announcement/chatIds/${userChatId}`).set(true); } catch (e) {}
          // Global chat index for fast lookup
          try { await adminDb.ref(`telegramChatIndex/${userChatId}`).set({ tenantId, queueKey: attach.queueKey || null, connectedAt: nowIso }); } catch (e) {}

          // Build reply with queue details
          const entry = attach.entry || {};
          const queueId = entry.queueId || tokenRecord.queueId || tokenRecord.queueKey || attach.queueKey || 'Unknown';

          // Get counter name
          let counterName = tokenRecord.counterName || entry.counterName || 'Unassigned';
          if (counterName === 'Unassigned' && (entry.counterId || tokenRecord.counterId)) {
            try {
              const cSnap = await adminDb.ref(`tenants/${tenantId}/counters/${entry.counterId || tokenRecord.counterId}`).get().catch(() => null);
              if (cSnap && cSnap.exists && cSnap.exists()) {
                counterName = cSnap.val().name || counterName;
              }
            } catch (e) {}
          }

          const reply = [
            '✅ <b>Connected to QueueJoy!</b>',
            `🧾 Your number: <b>${queueId}</b>`,
            `🪑 Counter: <b>${counterName}</b>`,
            '',
            'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.',
          ].join('\n');

          await sendTelegram(userChatId, reply, { reply_markup: makeConnectedKeyboard(attach.queueKey) });
          return { statusCode: 200, body: 'OK' };
        } else {
          console.log('attach failed:', attach);
          await sendTelegram(userChatId, [
            '⚠️ Could not connect with that token.',
            '',
            'Please open your status page and tap <b>Connect Telegram</b> to get a fresh link.',
          ].join('\n'), { reply_markup: makeExploreKeyboard() });
          return { statusCode: 200, body: 'OK' };
        }
      } else {
        await sendTelegram(userChatId, 'Server cannot complete connection right now. Please try again later.', { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
    }

    // No token, no command — try to show linked queue
    if (adminDb) {
      const resolved = await resolveChatToTenantAndEntry(adminDb, userChatId);
      if (resolved && resolved.tenantId && resolved.queueKey) {
        const ent = resolved.entry;
        const queueId = ent.queueId || ent.number || ent.ticket || 'Unknown';
        let counterName = 'Unassigned';
        if (ent.counterId) {
          try {
            const cSnap = await adminDb.ref(`tenants/${resolved.tenantId}/counters/${ent.counterId}`).get().catch(() => null);
            if (cSnap && cSnap.exists && cSnap.exists()) counterName = cSnap.val().name || counterName;
          } catch (e) {}
        }
        const reply = [
          'ℹ️ <b>Queue status for this chat:</b>',
          `🧾 Number: <b>${queueId}</b>`,
          `🪑 Counter: <b>${counterName}</b>`,
          `✅ Connected: Yes`,
        ].join('\n');
        await sendTelegram(userChatId, reply, { reply_markup: makeExploreKeyboard() });
        return { statusCode: 200, body: 'OK' };
      }
    }

    // Default: connect instructions
    const connectInstructions = [
      '👋 <b>Hi!</b> I couldn\'t find a queue linked to this chat.',
      '',
      'To connect:',
      '1. Open the QueueJoy status page you were given',
      '2. Tap <b>Connect via Telegram</b>',
      '',
      'Or paste the token link here and I\'ll try to connect you.',
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions, { reply_markup: makeExploreKeyboard() });
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err && (err.stack || err));
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

/* ---------- /status command handler ---------- */
async function handleStatusCommand(adminDb, FIREBASE_DB_URL, chatId) {
  if (!adminDb && !FIREBASE_DB_URL) {
    await sendTelegram(chatId, '⚠️ Server misconfigured: no Firebase access.');
    return { statusCode: 200, body: 'OK' };
  }

  let resolved = null;
  if (adminDb) {
    resolved = await resolveChatToTenantAndEntry(adminDb, chatId);
  } else {
    await sendTelegram(chatId, 'Status lookup currently unavailable. Please open your status page.', { reply_markup: makeExploreKeyboard() });
    return { statusCode: 200, body: 'OK' };
  }

  if (resolved && resolved.tenantId && resolved.queueKey) {
    const ent = resolved.entry;
    const queueId = ent.queueId || ent.number || ent.ticket || 'Unknown';
    let counterName = 'Unassigned';
    if (ent.counterId) {
      try {
        const cSnap = await adminDb.ref(`tenants/${resolved.tenantId}/counters/${ent.counterId}`).get().catch(() => null);
        if (cSnap && cSnap.exists && cSnap.exists()) counterName = cSnap.val().name || counterName;
      } catch (e) {}
    }

    const status = ent.status || 'waiting';
    const reply = [
      '📊 <b>Your Queue Status</b>',
      '',
      `🧾 Number: <b>${queueId}</b>`,
      `🪑 Counter: <b>${counterName}</b>`,
      `📌 Status: <b>${status}</b>`,
      `✅ Telegram: Connected`,
    ].join('\n');
    await sendTelegram(chatId, reply, { reply_markup: makeExploreKeyboard() });
  } else {
    await sendTelegram(chatId, 'No queue linked to this chat. Open your status page and tap <b>Connect Telegram</b>.', { reply_markup: makeExploreKeyboard() });
  }
  return { statusCode: 200, body: 'OK' };
}