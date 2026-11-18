'use strict';

/*
  telegramWebhook.js — QueueJoy Tenant-Aware Telegram Bot
  Netlify Serverless Function

  What this fixes:
  - Uses FIREBASE_SERVICE_ACCOUNT_BASE64 on Netlify (not applicationDefault)
  - Handles /start, /start <token>, raw pasted token, /help, /status
  - Resolves token from all 3 token paths
  - Writes chatId back into the queue record
  - Writes telegramChatIndex/{chatId}
  - Logs notifications/performed entries
  - Friendly, customer-focused replies
  - Keeps tenant-aware queue linking stable
*/

const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const SITE_BASE = process.env.SITE_BASE || 'https://queuejoy-live.netlify.app';
const EXPLORE_URL = process.env.EXPLORE_URL || 'https://helloqueuejoy.netlify.app';

function safe(v, d = '') {
  if (v === 0) return '0';
  if (v === undefined || v === null) return d;
  const s = String(v).trim();
  return s || d;
}

function now() {
  return new Date().toISOString();
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeToken(raw) {
  if (!raw) return null;

  let t = String(raw).trim();

  try {
    if (t.includes('t.me/')) {
      const u = new URL(t, 'https://example.invalid');
      if (u.searchParams.has('start')) return safe(u.searchParams.get('start'));
    }
  } catch {}

  try {
    if (t.includes('?')) {
      const u = new URL(t, 'https://example.invalid');
      if (u.searchParams.has('start')) return safe(u.searchParams.get('start'));
    }
  } catch {}

  const startMatch = t.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
  if (startMatch && startMatch[1]) return safe(startMatch[1]);

  const idx = t.indexOf('start=');
  if (idx !== -1) return safe(t.slice(idx + 6).split('&')[0]);

  return t || null;
}

function tokenLooksValid(t) {
  const s = safe(t);
  return s.length >= 6 && s.length < 200;
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
      [{ text: '🌐 Explore QueueJoy', url: EXPLORE_URL }],
      [{ text: '📊 Check Status', callback_data: 'status' }, { text: '❓ Help', callback_data: 'help' }],
    ],
  };
}

function makeExploreKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🌐 Explore QueueJoy', url: EXPLORE_URL }],
      [{ text: '📊 Check Status', callback_data: 'status' }, { text: '❓ Help', callback_data: 'help' }],
    ],
  };
}

/* =========================
   Firebase Admin init
   ========================= */

function initAdminDatabase() {
  const admin = require('firebase-admin');

  if (admin.apps && admin.apps.length > 0) {
    return admin.database();
  }

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    null;

  if (!raw) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64');
  }

  let sa = null;
  try {
    sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    sa = JSON.parse(raw);
  }

  const dbUrl =
    process.env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DB_URL ||
    process.env.FIREBASE_RTDB_URL ||
    '';

  if (!dbUrl) {
    throw new Error('Missing FIREBASE_DATABASE_URL');
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: dbUrl,
  });

  return admin.database();
}

/* =========================
   Telegram API
   ========================= */

async function sendTelegram(chatId, text, extra = {}) {
  if (!BOT_TOKEN) {
    console.error('[telegramWebhook] BOT_TOKEN is missing');
    return { ok: false, error: 'missing_bot_token' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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

    const responseData = await res.json().catch(() => null);
    if (!res.ok || responseData?.ok === false) {
      console.error('[telegramWebhook] sendMessage failed', res.status);
      return { ok: false, error: `http_${res.status}` };
    }

    return { ok: true };
  } catch (e) {
    console.error('[telegramWebhook] sendMessage request failed', e?.name || 'NetworkError');
    return { ok: false, error: 'network_error' };
  }
}

async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      }),
    });
  } catch (e) {
    console.error('[telegramWebhook] answerCallbackQuery failed', e?.name || 'NetworkError');
  }
}

/* =========================
   Token resolution
   ========================= */

async function resolveTokenToTenant(db, token) {
  if (!db || !token) return null;

  // 1) global lookup
  try {
    const gSnap = await db.ref(`telegramTokens/${token}`).get().catch(() => null);
    if (gSnap?.exists?.()) {
      const val = gSnap.val() || {};
      const tenantId = safe(val.tenantId || val.tenant || '');
      if (tenantId) return { tenantId, tokenRecord: val, tokenPath: `telegramTokens/${token}`, source: 'global' };
    }
  } catch (e) {
    console.warn('[telegramWebhook] global token lookup failed', e?.name || 'DatabaseError');
  }

  // 2) tenant integration path + tenant token path
  try {
    const slugsSnap = await db.ref('slugs').get().catch(() => null);
    if (slugsSnap?.exists?.()) {
      const slugs = slugsSnap.val() || {};
      for (const slugKey of Object.keys(slugs)) {
        const mapping = slugs[slugKey];
        const tenantId = typeof mapping === 'string' ? mapping : mapping?.tenantId || null;
        if (!tenantId) continue;

        const p1 = await db.ref(`tenants/${tenantId}/integrations/telegram/tokens/${token}`).get().catch(() => null);
        if (p1?.exists?.()) {
          return { tenantId, tokenRecord: p1.val() || {}, tokenPath: `tenants/${tenantId}/integrations/telegram/tokens/${token}`, source: `tenant-integrations:${tenantId}` };
        }

        const p2 = await db.ref(`tenants/${tenantId}/telegramTokens/${token}`).get().catch(() => null);
        if (p2?.exists?.()) {
          return { tenantId, tokenRecord: p2.val() || {}, tokenPath: `tenants/${tenantId}/telegramTokens/${token}`, source: `tenant-tokens:${tenantId}` };
        }
      }
    }
  } catch (e) {
    console.warn('[telegramWebhook] tenant token scan failed', e?.name || 'DatabaseError');
  }

  return null;
}

/* =========================
   Queue resolution
   ========================= */

async function resolveExactQueue(db, tenantId, tokenRecord) {
  if (!db || !tenantId || !tokenRecord) return null;

  const queueKey = safe(tokenRecord.queueKey || '');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(queueKey)) return null;
  if (tokenRecord.tenantId && safe(tokenRecord.tenantId) !== safe(tenantId)) return null;

  const exactPaths = [
    `tenants/${tenantId}/queue/${queueKey}`,
    `tenants/${tenantId}/public/queues/${queueKey}`,
    `tenants/${tenantId}/public/queue/${queueKey}`,
  ];
  for (const p of exactPaths) {
    try {
      const snap = await db.ref(p).get().catch(() => null);
      if (snap?.exists?.()) {
        return { queueKey, entry: snap.val() || {}, path: p, via: 'exact-tenant-path' };
      }
    } catch {}
  }
  return null;
}

async function resolveCounterName(db, tenantId, entry, tokenRecord) {
  const candidates = [
    entry?.counterName,
    tokenRecord?.counterName,
    entry?.counter,
    tokenRecord?.counter,
  ];

  for (const c of candidates) {
    if (c && safe(c) && safe(c) !== 'Unassigned') return safe(c);
  }

  const counterId = safe(entry?.counterId || tokenRecord?.counterId || entry?.counterAssigned || '');
  if (!counterId) return null;

  try {
    const cSnap = await db.ref(`tenants/${tenantId}/counters/${counterId}`).get().catch(() => null);
    if (cSnap?.exists?.()) {
      const val = cSnap.val() || {};
      const name = val.name || val.displayName || val.label || null;
      if (name && safe(name)) return safe(name);
    }
  } catch (e) {
    console.warn('[telegramWebhook] counter lookup failed', e?.name || 'DatabaseError');
  }

  return null;
}

/* =========================
   Chat index / status resolution
   ========================= */

async function resolveChatToTenantAndEntry(db, chatId) {
  if (!db || !chatId) return null;

  // 1) chat index first
  try {
    const idxSnap = await db.ref(`telegramChatIndex/${chatId}`).get().catch(() => null);
    if (idxSnap?.exists?.()) {
      const rec = idxSnap.val() || {};
      const tenantId = safe(rec.tenantId || '');
      const queueKey = safe(rec.queueKey || '');

      if (tenantId && queueKey) {
        for (const base of [`tenants/${tenantId}/public/queues`, `tenants/${tenantId}/public/queue`, `tenants/${tenantId}/queue`]) {
          const qSnap = await db.ref(`${base}/${queueKey}`).get().catch(() => null);
          if (qSnap?.exists?.()) {
            return {
              tenantId,
              queueKey,
              entry: qSnap.val() || {},
              slug: safe(rec.slug || ''),
              source: 'telegramChatIndex',
            };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[telegramWebhook] chat index lookup failed', e?.name || 'DatabaseError');
  }

  // 2) fallback scan by chatId / telegramChatId in tenant queues
  try {
    const slugsSnap = await db.ref('slugs').get().catch(() => null);
    if (!slugsSnap?.exists?.()) return null;

    const slugs = slugsSnap.val() || {};
    for (const slugKey of Object.keys(slugs)) {
      const mapping = slugs[slugKey];
      const tenantId = typeof mapping === 'string' ? mapping : mapping?.tenantId || null;
      if (!tenantId) continue;

      for (const base of [`tenants/${tenantId}/public/queues`, `tenants/${tenantId}/public/queue`, `tenants/${tenantId}/queue`]) {
        try {
          const byChat = await db.ref(base).orderByChild('chatId').equalTo(chatId).get().catch(() => null);
          if (byChat?.exists?.()) {
            const val = byChat.val() || {};
            const key = Object.keys(val)[0];
            return { tenantId, queueKey: key, entry: val[key] || {}, slug: slugKey, source: `chatScan:${base}` };
          }

          const byTelegramChat = await db.ref(base).orderByChild('telegramChatId').equalTo(chatId).get().catch(() => null);
          if (byTelegramChat?.exists?.()) {
            const val = byTelegramChat.val() || {};
            const key = Object.keys(val)[0];
            return { tenantId, queueKey: key, entry: val[key] || {}, slug: slugKey, source: `telegramChatIdScan:${base}` };
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[telegramWebhook] fallback chat scan failed', e?.name || 'DatabaseError');
  }

  return null;
}

/* =========================
   Writes
   ========================= */

async function attachChatToQueue(db, tenantId, tokenRecord, chatId, resolvedQueue = null) {
  resolvedQueue = resolvedQueue || await resolveExactQueue(db, tenantId, tokenRecord);
  if (!resolvedQueue?.queueKey) return { ok: false, reason: 'no-queue-match' };

  const queueKey = resolvedQueue.queueKey;
  const nowIso = now();
  const queueRef = db.ref(resolvedQueue.path);
  let rejectionReason = '';
  let alreadyLinked = false;
  let transaction;
  try {
    transaction = await queueRef.transaction(current => {
      if (!current || typeof current !== 'object') { rejectionReason = 'no-queue-match'; return; }
      if (current.tenantId && safe(current.tenantId) !== safe(tenantId)) { rejectionReason = 'tenant-mismatch'; return; }
      const status = safe(current.status || '').toLowerCase().replace(/[\s_-]+/g, '');
      if (['cancelled', 'canceled', 'noshow', 'skipped'].includes(status)) { rejectionReason = 'queue-not-active'; return; }
      const existingChatId = current.telegramChatId || current.chatId || current.telegram_chat_id || '';
      if (existingChatId && String(existingChatId) !== String(chatId)) { rejectionReason = 'already-linked'; return; }
      if (existingChatId && String(existingChatId) === String(chatId) && current.telegramConnected) {
        alreadyLinked = true;
        return;
      }
      return {
        ...current,
        chatId,
        telegramChatId: chatId,
        telegramConnected: true,
        connectedAt: current.connectedAt || nowIso,
        telegramTokenUsedAt: nowIso,
        updatedAt: nowIso,
      };
    }, undefined, false);
  } catch (e) {
    console.error('[telegramWebhook] queue record transaction failed', e?.name || 'DatabaseError');
    return { ok: false, reason: 'queue-update-failed' };
  }
  if (!transaction?.committed && !alreadyLinked) return { ok: false, reason: rejectionReason || 'queue-update-failed' };

  const entry = transaction?.snapshot?.val() || resolvedQueue.entry || {};
  const slug = safe(tokenRecord?.slug || entry?.slug || '');

  try {
    await db.ref().update({
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
  } catch (e) {
    console.warn('[telegramWebhook] auxiliary bookkeeping update failed', e?.name || 'DatabaseError');
  }

  return { ok: true, queueKey, entry, slug, via: resolvedQueue.via, path: resolvedQueue.path };
}

function tokenExpiryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function claimTokenUse(db, tokenPath, tenantId) {
  if (!db || !tokenPath || !tenantId) return { ok: false, reason: 'missing-token-path' };
  const tokenRef = db.ref(tokenPath);
  const claimedAt = now();
  try {
    const result = await tokenRef.transaction(current => {
      if (!current || typeof current !== 'object') return;
      if (safe(current.tenantId || current.tenant) !== safe(tenantId) || current.used === true) return;
      const expiry = tokenExpiryMs(current.expiresAt);
      if (expiry == null || expiry <= Date.now()) return;
      return { ...current, used: true, usedAt: claimedAt };
    }, undefined, false);
    if (result?.committed) return { ok: true, usedAt: claimedAt, record: result.snapshot?.val?.() || {} };
    const current = result?.snapshot?.val?.() || null;
    if (!current) return { ok: false, reason: 'token-missing' };
    if (current.used === true) return { ok: false, reason: 'token-used', record: current };
    if (safe(current.tenantId || current.tenant) !== safe(tenantId)) return { ok: false, reason: 'tenant-mismatch' };
    if ((tokenExpiryMs(current.expiresAt) || 0) <= Date.now()) return { ok: false, reason: 'token-expired' };
    return { ok: false, reason: 'token-not-claimable' };
  } catch (error) {
    console.warn('[telegramWebhook] token claim failed', error?.name || 'DatabaseError');
    return { ok: false, reason: 'token-claim-failed' };
  }
}

async function releaseTokenClaim(db, tokenPath, usedAt) {
  if (!db || !tokenPath || !usedAt) return;
  try {
    await db.ref(tokenPath).transaction(current => {
      if (!current || current.used !== true || current.usedAt !== usedAt) return;
      const next = { ...current, used: false };
      delete next.usedAt;
      return next;
    }, undefined, false);
  } catch (error) {
    console.warn('[telegramWebhook] token claim rollback failed', error?.name || 'DatabaseError');
  }
}

async function claimConfirmationOnce(db, tokenPath) {
  const claimAt = now();
  if (!db || !tokenPath) return null;
  try {
    const result = await db.ref(tokenPath).transaction(current => {
      if (!current || current.used !== true || current.confirmationSentAt) return;
      const pendingAt = tokenExpiryMs(current.confirmationClaimedAt);
      if (pendingAt && Date.now() - pendingAt < 90000) return;
      return { ...current, confirmationClaimedAt: claimAt };
    }, undefined, false);
    return result?.committed ? claimAt : null;
  } catch (error) {
    console.warn('[telegramWebhook] confirmation claim failed', error?.name || 'DatabaseError');
    return null;
  }
}

async function finishConfirmation(db, tokenPath, claimAt, sent) {
  if (!db || !tokenPath || !claimAt) return;
  try {
    await db.ref(tokenPath).transaction(current => {
      if (!current || current.confirmationClaimedAt !== claimAt) return;
      const next = { ...current };
      delete next.confirmationClaimedAt;
      if (sent) next.confirmationSentAt = now();
      return next;
    }, undefined, false);
  } catch (error) {
    console.warn('[telegramWebhook] confirmation state update failed', error?.name || 'DatabaseError');
  }
}

async function sendConnectedConfirmation(db, tokenPath, chatId, text, keyboard) {
  const claimAt = await claimConfirmationOnce(db, tokenPath);
  if (!claimAt) return false;
  const result = await sendTelegram(chatId, text, { reply_markup: keyboard });
  await finishConfirmation(db, tokenPath, claimAt, Boolean(result?.ok));
  return Boolean(result?.ok);
}

async function markTokenUsedAllPaths(db, tenantId, token) {
  const nowIso = now();
  const paths = [
    `telegramTokens/${token}`,
    `tenants/${tenantId}/telegramTokens/${token}`,
    `tenants/${tenantId}/integrations/telegram/tokens/${token}`,
  ];

  const updates = {};
  for (const p of paths) {
    updates[`${p}/used`] = true;
    updates[`${p}/usedAt`] = nowIso;
  }

  try {
    await db.ref().update(updates);
  } catch (e) {
    console.warn('[telegramWebhook] markTokenUsedAllPaths failed', e?.name || 'DatabaseError');
  }
}

async function logNotificationPerformed(db, { tenantId, queueKey, queueId, queueNumber, messageType, extra }) {
  if (!db || !tenantId) return;

  const logEntry = {
    timestamp: now(),
    tenantId,
    queueKey: queueKey || '',
    queueId: queueId || '',
    queueNumber: queueNumber || '',
    messageType: messageType || 'telegram_connected',
    source: 'telegramWebhook',
    ...(extra || {}),
  };

  try {
    await db.ref(`tenants/${tenantId}/notifications/performed`).push(logEntry);
  } catch (e) {
    console.warn('[telegramWebhook] logNotificationPerformed failed', e?.name || 'DatabaseError');
  }
}

/* =========================
   Replies
   ========================= */

async function handleHelp(chatId) {
  await sendTelegram(
    chatId,
    [
      '💡 <b>QueueJoy Help</b>',
      '',
      '📊 /status — Check your queue position',
      '❓ /help — Show this help message',
      '',
      'To connect your ticket:',
      '1️⃣ Open your QueueJoy status page',
      '2️⃣ Tap <b>📲 Connect Telegram</b>',
      '3️⃣ Tap <b>Start</b> in Telegram',
      '',
      '🔔 You will receive turn alerts, promotions, discounts, and important updates here.',
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Check Status', callback_data: 'status' }],
          [{ text: '🌐 Open QueueJoy', url: EXPLORE_URL }],
        ],
      },
    }
  );
}

async function handleStatusCommand(db, chatId) {
  if (!db) {
    await sendTelegram(
      chatId,
      [
        '⚠️ Status lookup is temporarily unavailable.',
        '',
        'Please open your QueueJoy status page to check your position.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  const resolved = await resolveChatToTenantAndEntry(db, chatId);
  if (!resolved?.tenantId || !resolved?.queueKey) {
    await sendTelegram(
      chatId,
      [
        '🔍 No active ticket found for this chat yet.',
        '',
        'Please open your QueueJoy status page and tap <b>📲 Connect Telegram</b>.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  const ent = resolved.entry || {};
  const ticketLabel = safe(ent.queueNumber || ent.number || ent.queueId || resolved.queueKey || 'Your ticket');
  const counterName = (await resolveCounterName(db, resolved.tenantId, ent, {})) || 'your counter';
  const status = safe(ent.status || 'waiting');
  const tgConnected = Boolean(
    ent.telegramConnected ||
    ent.tgConnected ||
    ent.telegramChatId ||
    ent.telegram_chat_id ||
    ent.chatId
  );

  await sendTelegram(
    chatId,
    [
      '📊 <b>Your Queue Status</b>',
      '',
      `🎫 Ticket: <b>${escapeHtml(ticketLabel)}</b>`,
      `🪑 Counter: <b>${escapeHtml(counterName)}</b>`,
      `📌 Status: <b>${escapeHtml(status)}</b>`,
      `🔔 Telegram: <b>${tgConnected ? 'Connected' : 'Not connected'}</b>`,
      '',
      'We will alert you here when it is your turn.',
    ].join('\n'),
    {
      reply_markup: makeConnectedKeyboard(
        resolved.queueKey,
        resolved.slug,
        resolved.tenantId,
        ticketLabel
      ),
    }
  );
}

async function handleStartWithNoToken(chatId) {
  await sendTelegram(
    chatId,
    [
      '👋 <b>Welcome to QueueJoy!</b>',
      '',
      'To connect your ticket:',
      '',
      '1️⃣ Open your QueueJoy status page',
      '2️⃣ Tap <b>📲 Connect Telegram</b>',
      '3️⃣ Tap <b>Start</b> in Telegram',
      '',
      '🔔 You will get:',
      '• Turn alerts',
      '• Promotions',
      '• Discounts',
      '• Important updates',
      '',
      'If you already have a token link, paste it here and I will connect you right away.',
    ].join('\n'),
    { reply_markup: makeExploreKeyboard() }
  );
}

async function handleTokenConnect(db, chatId, tokenRaw) {
  const normalized = normalizeToken(tokenRaw);
  const showRefreshLink = () => sendTelegram(
    chatId,
    [
      '⚠️ This link is expired, invalid, or already connected to a different chat.',
      '',
      'Please return to your QueueJoy status page and tap <b>Connect Telegram</b> to request a new link.',
    ].join('\n'),
    { reply_markup: makeExploreKeyboard() }
  );
  if (!tokenLooksValid(normalized)) {
    await sendTelegram(
      chatId,
      [
        'Hmm, that does not look like a valid link or token. 🤔',
        '',
        'Please go back to your QueueJoy page and tap <b>📲 Connect Telegram</b> to get a fresh link.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  const resolved = await resolveTokenToTenant(db, normalized);
  if (!resolved?.tenantId) {
    await sendTelegram(
      chatId,
      [
        '⚠️ This link is expired or no longer recognized.',
        '',
        'Please go back to your QueueJoy page and tap <b>📲 Connect Telegram</b> again.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  const tenantId = resolved.tenantId;
  const tokenRecord = resolved.tokenRecord || {};
  if (tokenRecord.tenantId && safe(tokenRecord.tenantId) !== safe(tenantId)) {
    await showRefreshLink();
    return;
  }
  const slug = safe(tokenRecord.slug || '');
  const exactQueue = await resolveExactQueue(db, tenantId, tokenRecord);
  if (!exactQueue?.queueKey || (exactQueue.entry?.tenantId && safe(exactQueue.entry.tenantId) !== safe(tenantId))) {
    await sendTelegram(
      chatId,
      [
        'We could not find the exact ticket for this link. 🔍',
        '',
        'Please open your QueueJoy status page and request a fresh Telegram link.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  const initialEntry = exactQueue.entry || {};
  const initialStatus = safe(initialEntry.status || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['cancelled', 'canceled', 'noshow', 'skipped'].includes(initialStatus)) {
    await showRefreshLink();
    return;
  }
  const initialChatId = initialEntry.telegramChatId || initialEntry.chatId || initialEntry.telegram_chat_id || '';
  const alreadyConnectedToThisChat = Boolean(initialEntry.telegramConnected && String(initialChatId) === String(chatId));

  if (tokenRecord.used === true) {
    if (!alreadyConnectedToThisChat) {
      await showRefreshLink();
      return;
    }
    const ticketLabel = safe(initialEntry.queueNumber || initialEntry.number || tokenRecord.queueNumber || exactQueue.queueKey);
    const counterName = (await resolveCounterName(db, tenantId, initialEntry, tokenRecord)) || 'your assigned counter';
    await sendConnectedConfirmation(
      db,
      resolved.tokenPath,
      chatId,
      [
        '✅ <b>Your ticket is already connected.</b>',
        '',
        `🎫 Ticket: <b>${escapeHtml(ticketLabel)}</b>`,
        `🪑 Counter: <b>${escapeHtml(counterName)}</b>`,
        '',
        'We will send your turn alerts here.',
      ].join('\n'),
      makeConnectedKeyboard(exactQueue.queueKey, slug || exactQueue.entry?.slug, tenantId, ticketLabel)
    );
    return;
  }

  const expiry = tokenExpiryMs(tokenRecord.expiresAt);
  if (expiry == null || expiry <= Date.now()) {
    await showRefreshLink();
    return;
  }
  if (initialChatId && String(initialChatId) !== String(chatId)) {
    await showRefreshLink();
    return;
  }

  const claim = await claimTokenUse(db, resolved.tokenPath, tenantId);
  if (!claim.ok) {
    if (claim.reason === 'token-used') {
      const latestQueue = await resolveExactQueue(db, tenantId, tokenRecord);
      const linkedChatId = latestQueue?.entry?.telegramChatId || latestQueue?.entry?.chatId || latestQueue?.entry?.telegram_chat_id || '';
      if (latestQueue?.entry?.telegramConnected && String(linkedChatId) === String(chatId)) {
        const ticketLabel = safe(latestQueue.entry.queueNumber || latestQueue.entry.number || tokenRecord.queueNumber || latestQueue.queueKey);
        const counterName = (await resolveCounterName(db, tenantId, latestQueue.entry, tokenRecord)) || 'your assigned counter';
        await sendConnectedConfirmation(
          db,
          resolved.tokenPath,
          chatId,
          [
            '✅ <b>Your ticket is already connected.</b>',
            '',
            `🎫 Ticket: <b>${escapeHtml(ticketLabel)}</b>`,
            `🪑 Counter: <b>${escapeHtml(counterName)}</b>`,
            '',
            'We will send your turn alerts here.',
          ].join('\n'),
          makeConnectedKeyboard(latestQueue.queueKey, slug || latestQueue.entry?.slug, tenantId, ticketLabel)
        );
        return;
      }
    }
    await showRefreshLink();
    return;
  }

  const attach = await attachChatToQueue(db, tenantId, tokenRecord, chatId, exactQueue);
  if (!attach?.ok) {
    await releaseTokenClaim(db, resolved.tokenPath, claim.usedAt);
    await sendTelegram(
      chatId,
      [
        attach.reason === 'already-linked'
          ? 'This ticket is already linked to a different Telegram chat.'
          : 'We could not attach Telegram to this ticket just yet. 🔍',
        '',
        'Please open your QueueJoy status page and request a fresh link if needed.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );
    return;
  }

  await markTokenUsedAllPaths(db, tenantId, normalized);

  const entry = attach.entry || {};
  const ticketLabel = safe(
    entry.queueNumber ||
    entry.number ||
    tokenRecord.queueNumber ||
    tokenRecord.queueId ||
    attach.queueKey
  );

  const counterName =
    (await resolveCounterName(db, tenantId, entry, tokenRecord)) || 'your assigned counter';

  const queueId = safe(entry.queueId || tokenRecord.queueId || '');
  const queueNumber = safe(entry.queueNumber || tokenRecord.queueNumber || ticketLabel);

  await logNotificationPerformed(db, {
    tenantId,
    queueKey: attach.queueKey || '',
    queueId,
    queueNumber,
    messageType: 'telegram_connected',
    extra: {
      counterName,
      slug: slug || attach.slug || '',
      via: attach.via,
      path: attach.path,
      result: 'success',
    },
  });

  await sendConnectedConfirmation(
    db,
    resolved.tokenPath,
    chatId,
    [
      attach.alreadyLinked ? '✅ <b>This ticket is already connected.</b>' : '✅ <b>You are connected to QueueJoy!</b>',
      '',
      `🎫 Your ticket: <b>${escapeHtml(ticketLabel)}</b>`,
      `🪑 Counter: <b>${escapeHtml(counterName)}</b>`,
      '',
      '🔔 We will send your alerts here when it is your turn.',
      '',
      attach.alreadyLinked ? 'No changes were needed. Your alerts will continue here.' : 'You can safely close the page now — we have your Telegram connected.',
    ].join('\n'),
    makeConnectedKeyboard(attach.queueKey, slug || attach.slug, tenantId, ticketLabel)
  );
}

/* =========================
   Main handler
   ========================= */

exports.handler = async (event) => {
  try {
    if (!event || event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let db;
    try {
      db = initAdminDatabase();
    } catch (e) {
      console.error('[telegramWebhook] Firebase init failed', e?.name || 'DatabaseError');
      // We still return 200 so Telegram won't keep retrying forever.
      return { statusCode: 200, body: 'OK' };
    }

    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    /* ========== callback_query ========== */
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;

      await answerCallback(cb.id);

      if (!chatId) return { statusCode: 200, body: 'OK' };

      if (cb.data === 'help') {
        await handleHelp(chatId);
        return { statusCode: 200, body: 'OK' };
      }

      if (cb.data === 'status') {
        await handleStatusCommand(db, chatId);
        return { statusCode: 200, body: 'OK' };
      }

      return { statusCode: 200, body: 'OK' };
    }

    /* ========== message ========== */
    const msg = update.message || update.edited_message || null;
    const chatId = msg?.chat?.id ?? msg?.from?.id ?? null;
    if (!chatId) return { statusCode: 200, body: 'No chat id' };

    const text = safe(msg?.text || msg?.caption || '');

    /* ========== /help ========== */
    if (text === '/help' || text.startsWith('/help@')) {
      await handleHelp(chatId);
      return { statusCode: 200, body: 'OK' };
    }

    /* ========== /status ========== */
    if (text === '/status' || text.startsWith('/status@')) {
      await handleStatusCommand(db, chatId);
      return { statusCode: 200, body: 'OK' };
    }

    /* ========== /start ========== */
    if (text.startsWith('/start')) {
      const token = normalizeToken(text);

      // /start with no token => friendly onboarding, never fail
      if (!token || token === '/start') {
        await handleStartWithNoToken(chatId);
        return { statusCode: 200, body: 'OK' };
      }

      // /start <token>
      await handleTokenConnect(db, chatId, token);
      return { statusCode: 200, body: 'OK' };
    }

    /* ========== raw pasted token ========== */
    if (text && text.length < 200) {
      const rawToken = normalizeToken(text);
      if (rawToken && rawToken !== text || rawToken) {
        const maybe = rawToken;
        const resolved = await resolveTokenToTenant(db, maybe);
        if (resolved?.tenantId) {
          await handleTokenConnect(db, chatId, maybe);
          return { statusCode: 200, body: 'OK' };
        }
      }
    }

    /* ========== fallback ========== */
    await sendTelegram(
      chatId,
      [
        '👋 <b>Welcome to QueueJoy!</b>',
        '',
        'Open your QueueJoy status page and tap <b>📲 Connect Telegram</b> to link your ticket.',
        '',
        'You can also tap /help or /status anytime.',
      ].join('\n'),
      { reply_markup: makeExploreKeyboard() }
    );

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('[telegramWebhook] Handler error', err?.name || 'Error');
    return { statusCode: 200, body: 'OK' };
  }
};
