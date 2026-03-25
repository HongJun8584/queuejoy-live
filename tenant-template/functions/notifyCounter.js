'use strict';

// ============================================================
// notifyCounter.js — QueueJoy Tenant-Aware Notification Backend
// Netlify Serverless Function
// ============================================================
// Features:
//   - Tenant-scoped Firebase reads/writes (tenants/{tenantId}/...)
//   - Custom notification templates from tenant settings
//   - Duplicate notification protection
//   - firebase-admin with REST fallback
//   - Redis with /tmp file fallback
//   - Promise.allSettled parallel Telegram sends
//   - Service analytics & series stats
//   - Customizable Telegram inline buttons
//   - Full analytics/serviceEvents with all required fields
// ============================================================

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');
const path = require('path');

// ===== Config =====
const REDIS_URL = process.env.REDIS_URL || null;
const BOT_TOKEN = process.env.BOT_TOKEN || null;
const DATABASE_URL = (
  process.env.FIREBASE_DATABASE_URL ||
  process.env.FIREBASE_DB_URL ||
  process.env.FIREBASE_RTDB_URL ||
  ''
).replace(/\/$/, '');
const TMP_STORE = '/tmp/queuejoy_store.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MOVING_AVG_COUNT = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

// ===== Redis Setup =====
let useRedis = false;
let RedisClient = null;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis not available, falling back to ephemeral store:', e.message);
  }
}

// ===== Default Templates =====
const DEFAULT_TEMPLATES = {
  calledMessage: '🎯 Dear customer,\n\nYour number <b>{calledFull}</b> has been called. Please proceed to <b>{counterName}</b>. Thank you.',
  reminderMessage: '🔔 REMINDER\nNumber <b>{calledFull}</b> was called. Your number is <b>{theirNumber}</b>. We\'ll notify you again when it\'s your turn.',
  welcomeMessage: '👋 Welcome! Your ticket <b>{theirNumber}</b> is registered. We\'ll notify you when it\'s your turn.',
  buttonLabel: '👉 Explore QueueJoy',
  buttonUrl: 'https://helloqueuejoy.netlify.app',
  footerText: '\n\nCurious how this works? Tap the button below to see tools your shop can use to keep customers happy.',
  includeFooter: true,
};

// ===== Helpers =====
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

const normalizeNumber = (n) => {
  if (n === undefined || n === null) return '';
  let s = String(n).trim();
  s = s.replace(/[\s\/\\]+/g, '-');
  s = s.replace(/[^A-Za-z0-9\-_.]/g, '');
  s = s.replace(/[-_.]{2,}/g, (m) => m[0]);
  return s.toUpperCase();
};

const seriesOf = (n) => {
  const cleaned = normalizeNumber(n);
  if (!cleaned) return '';
  const m = cleaned.match(/^([A-Z\-_.]+)(\d.*)?$/i);
  if (m) return (m[1] || '').toUpperCase();
  const parts = cleaned.split(/(\d+)/).filter(Boolean);
  return (parts[0] || '').toUpperCase();
};

const numericSuffix = (s) => {
  if (!s) return NaN;
  const m = String(s).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : NaN;
};

const isBehindCalled = (theirNumber, calledNumber) => {
  const t = normalizeNumber(theirNumber);
  const c = normalizeNumber(calledNumber);
  if (!t || !c) return false;
  const seriesT = seriesOf(t);
  const seriesC = seriesOf(c);
  if (seriesT !== seriesC) return false;
  const tn = numericSuffix(t);
  const cn = numericSuffix(c);
  if (!isNaN(tn) && !isNaN(cn)) return tn > cn;
  const tailT = t.slice(seriesT.length) || t;
  const tailC = c.slice(seriesC.length) || c;
  return tailT > tailC;
};

const ticketKeyFor = ({ ticketId, chatId, theirNumber }) =>
  ticketId ? String(ticketId) : `${String(chatId)}|${normalizeNumber(theirNumber)}`;

// ===== Template Renderer =====
function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value != null ? String(value) : '');
  }
  return result;
}

// ===== Store Helpers (single-write optimization) =====
async function loadStore(tenantId) {
  if (useRedis) return null;
  try {
    if (fs.existsSync(TMP_STORE)) {
      const raw = fs.readFileSync(TMP_STORE, 'utf8') || '{"tenants":{}}';
      const obj = JSON.parse(raw);
      obj.tenants = obj.tenants || {};
      obj.tenants[tenantId] = obj.tenants[tenantId] || { tickets: {}, stats: {} };
      return obj.tenants[tenantId];
    }
  } catch (e) { console.warn('loadStore', e.message); }
  return { tickets: {}, stats: {} };
}

async function saveStore(obj, tenantId) {
  if (useRedis) return;
  try {
    let root = { tenants: {} };
    if (fs.existsSync(TMP_STORE)) {
      try { root = JSON.parse(fs.readFileSync(TMP_STORE, 'utf8') || '{"tenants":{}}'); } catch (e) { root = { tenants: {} }; }
    }
    root.tenants = root.tenants || {};
    root.tenants[tenantId] = obj;
    fs.writeFileSync(TMP_STORE, JSON.stringify(root));
  } catch (e) { console.warn('saveStore', e.message); }
}

async function redisGet(key) {
  if (!RedisClient) return null;
  try { const v = await RedisClient.get(key); return v ? JSON.parse(v) : null; }
  catch (e) { console.warn('redisGet', e.message); return null; }
}
async function redisSet(key, val) {
  if (!RedisClient) return;
  try { await RedisClient.set(key, JSON.stringify(val)); }
  catch (e) { console.warn('redisSet', e.message); }
}

// ===== Firebase Admin Init =====
function tryInitAdmin() {
  let admin = null;
  try { admin = require('firebase-admin'); } catch (e) {
    return { ok: false, reason: 'firebase-admin-not-installed' };
  }
  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try { sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch (e) { try { sa = JSON.parse(raw); } catch (e2) { sa = null; } }
  }
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;
  try {
    if (sa) admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) { return { ok: false, reason: 'init_failed', detail: err?.message }; }
}

// ===== Tenant Resolution =====
async function resolveTenantIdWithAdmin(admin, slugOrId) {
  const db = admin.database();
  try {
    const sSnap = await db.ref(`slugs/${slugOrId}`).get().catch(() => null);
    if (sSnap && sSnap.exists && sSnap.exists()) {
      const val = sSnap.val();
      if (typeof val === 'string' && val.trim()) return { tenantId: val.trim(), source: 'slugs.value' };
      if (val && typeof val === 'object' && val.tenantId) return { tenantId: String(val.tenantId), source: 'slugs.obj' };
    }
  } catch (e) {}
  try {
    const tSnap = await db.ref(`tenants/${slugOrId}/meta`).get().catch(() => null);
    if (tSnap && tSnap.exists && tSnap.exists()) return { tenantId: slugOrId, source: 'direct-check' };
  } catch (e) {}
  return null;
}

// ===== Tenant Notification Settings =====
async function getTenantNotificationSettings(adminDb, tenantId) {
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/settings/notifications`).get().catch(() => null);
      if (snap && snap.exists && snap.exists()) return snap.val();
    } else if (DATABASE_URL) {
      const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/settings/notifications.json`);
      if (res.ok) { const data = await res.json(); if (data) return data; }
    }
  } catch (e) { console.warn('getTenantNotificationSettings', e?.message); }
  return null;
}

// ===== Tenant Public Config =====
async function getTenantPublicConfig(adminDb, tenantId) {
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/public/config`).get().catch(() => null);
      if (snap && snap.exists && snap.exists()) return snap.val();
    } else if (DATABASE_URL) {
      const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/public/config.json`);
      if (res.ok) { const data = await res.json(); if (data) return data; }
    }
  } catch (e) {}
  return {};
}

// ===== Duplicate Notification Check =====
async function checkDuplicateNotification(adminDb, tenantId, ticketId) {
  if (!ticketId) return false;
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/notifications/sent/${ticketId}`).get().catch(() => null);
      return snap && snap.exists && snap.exists();
    } else if (DATABASE_URL) {
      const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/notifications/sent/${encodeURIComponent(ticketId)}.json`);
      if (res.ok) { const data = await res.json(); return data !== null; }
    }
  } catch (e) {}
  return false;
}

async function markNotificationSent(adminDb, tenantId, ticketId, firebaseUpdates) {
  if (!ticketId) return;
  firebaseUpdates[`tenants/${tenantId}/notifications/sent/${ticketId}`] = { sentAt: Date.now() };
}

// ===== Telegram =====
function tgPrepareMessage(chatId, text, buttonLabel, buttonUrl, extraButtons = []) {
  const inlineKeyboard = [];
  if (buttonLabel && buttonUrl) {
    inlineKeyboard.push([{ text: buttonLabel, url: buttonUrl }]);
  }
  for (const btn of extraButtons) {
    if (btn && btn.text && btn.url) inlineKeyboard.push([btn]);
  }
  return {
    method: 'POST',
    url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(inlineKeyboard.length ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
    }),
    headers: { 'Content-Type': 'application/json' },
  };
}

async function tgSendPrepared(pref) {
  try {
    const res = await fetch(pref.url, { method: pref.method, headers: pref.headers, body: pref.body });
    const textResp = await res.text().catch(() => null);
    let json = null;
    try { json = textResp ? JSON.parse(textResp) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, bodyJson: json };
  } catch (err) { return { ok: false, error: String(err) }; }
}

// ===== Stats Helpers =====
async function loadSeriesStats(tenantId, series, store) {
  const empty = { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
  if (useRedis) {
    const s = await redisGet(`stats:${tenantId}:${series}`);
    return s || empty;
  }
  store.stats = store.stats || {};
  return store.stats[series] || empty;
}

async function saveSeriesStats(tenantId, series, stats, store, storeDirtyFlag) {
  if (useRedis) { await redisSet(`stats:${tenantId}:${series}`, stats); }
  else { store.stats = store.stats || {}; store.stats[series] = stats; storeDirtyFlag.dirty = true; }
}

// ===== Queue Fetch (tenant-scoped) =====
async function fetchQueueForSeriesTenant(adminDb, tenantId, series) {
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/queue`).orderByChild('series').equalTo(series).get().catch(() => null);
      if (snap && snap.exists && snap.exists()) return snap.val() || {};
    } else if (DATABASE_URL) {
      const url = `${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/queue.json?orderBy=${encodeURIComponent('"series"')}&equalTo=${encodeURIComponent('"' + series + '"')}`;
      const res = await fetch(url);
      if (res.ok) return await res.json() || {};
    }
  } catch (e) { console.warn('fetchQueueForSeriesTenant', e?.message); }
  return {};
}

async function fetchQueueAllTenant(adminDb, tenantId) {
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/queue`).get().catch(() => null);
      if (snap && snap.exists && snap.exists()) return snap.val() || {};
    } else if (DATABASE_URL) {
      const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/queue.json`);
      if (res.ok) return await res.json() || {};
    }
  } catch (e) { console.warn('fetchQueueAllTenant', e?.message); }
  return {};
}

// ===== Analytics =====
async function pushServiceEventTenant(adminDb, tenantId, evt) {
  // Ensure serviceMs is always a number
  if (evt.serviceMs === undefined || evt.serviceMs === null || isNaN(evt.serviceMs)) {
    evt.serviceMs = 0;
  }
  evt.serviceMs = Number(evt.serviceMs);

  try {
    if (adminDb) {
      await adminDb.ref(`tenants/${tenantId}/analytics/serviceEvents`).push(evt);
    } else if (DATABASE_URL) {
      await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/serviceEvents.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt),
      });
    }
  } catch (e) { console.warn('pushServiceEventTenant', e?.message); }
}

// ===== Privacy: remove number fields =====
function markNumberForDeletionTenant(tenantId, ticketId) {
  if (!ticketId) return {};
  const base = `tenants/${tenantId}/queue/${ticketId}`;
  return {
    [`${base}/number`]: null,
    [`${base}/queueId`]: null,
    [`${base}/recipientFull`]: null,
    [`${base}/fullNumber`]: null,
  };
}

// ===== MAIN HANDLER =====
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST' }) };
  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // ===== Tenant Resolution =====
  let tenantId = payload.tenantId ? String(payload.tenantId).trim() : '';
  const slug = payload.slug ? String(payload.slug).trim() :
    (event.queryStringParameters?.slug ? String(event.queryStringParameters.slug).trim() : '');

  const init = tryInitAdmin();
  const adminOk = init.ok && init.admin;
  const adminDb = adminOk ? init.admin.database() : null;

  if (!tenantId && slug) {
    if (adminDb) {
      const resolved = await resolveTenantIdWithAdmin(init.admin, slug);
      if (resolved?.tenantId) tenantId = resolved.tenantId;
    } else if (DATABASE_URL) {
      try {
        const s = await fetch(`${DATABASE_URL}/slugs/${encodeURIComponent(slug)}.json`);
        if (s.ok) {
          const j = await s.json();
          if (j && j.tenantId) tenantId = j.tenantId;
          else if (typeof j === 'string' && j) tenantId = j;
        }
      } catch (e) {}
    }
  }
  if (!tenantId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'tenantId or slug required' }) };

  // ===== Parse Payload =====
  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const counterId = payload.counterId ? String(payload.counterId).trim() : '';
  const payloadSessionId = payload.sessionId ? String(payload.sessionId).trim() : '';
  const extraInlineButtons = Array.isArray(payload.inlineButtons) ? payload.inlineButtons : [];

  if (!calledFull) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull required' }) };

  const calledSeries = seriesOf(calledFull);

  // ===== Load Tenant Notification Settings & Config (parallel) =====
  const [tenantSettings, tenantPublicCfg] = await Promise.all([
    getTenantNotificationSettings(adminDb, tenantId),
    getTenantPublicConfig(adminDb, tenantId),
  ]);

  const tpl = { ...DEFAULT_TEMPLATES, ...(tenantSettings || {}) };
  const tenantName = tenantPublicCfg?.displayName || slug || tenantId;

  const templateVars = {
    calledFull, counterName: counterName || 'the counter', tenantName,
    slug: slug || tenantId,
    exploreLabel: tpl.buttonLabel || DEFAULT_TEMPLATES.buttonLabel,
    exploreUrl: tpl.buttonUrl || DEFAULT_TEMPLATES.buttonUrl,
    customText: tpl.footerText || '',
  };

  // ===== Load Store =====
  let store = null;
  let storeDirty = { dirty: false };
  if (!useRedis) store = await loadStore(tenantId);

  // ===== Build Recipients =====
  let rawRecipients = Array.isArray(payload.recipients) ? payload.recipients.slice() : [];

  let preloadQueue = {};
  if (!rawRecipients.length) {
    if (calledSeries) preloadQueue = await fetchQueueForSeriesTenant(adminDb, tenantId, calledSeries);
    if (!preloadQueue || Object.keys(preloadQueue).length === 0) {
      preloadQueue = await fetchQueueAllTenant(adminDb, tenantId);
    }
    for (const [key, q] of Object.entries(preloadQueue || {})) {
      if (!q || q.status !== 'waiting') continue;
      const theirNumber = q.number || q.queueId || q.ticketId || key;
      if (!theirNumber) continue;
      if (calledSeries && seriesOf(theirNumber) !== calledSeries) continue;
      rawRecipients.push({
        chatId: q.chatId || q.chat_id || null,
        theirNumber, ticketId: key,
        createdAt: q.timestamp || q.connectedAt || q.createdAt || null,
        telegramConnected: q.telegramConnected || false,
        queueEntry: q,
      });
    }
  }

  // ===== Deduplicate =====
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id || null;
    const theirNumber = normalizeNumber(r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || r?.ticketNumber || '');
    if (!theirNumber) continue;
    const ticketIdKey = r?.ticketId || r?.queueKey || null;
    const key = ticketKeyFor({ ticketId: ticketIdKey, chatId, theirNumber });
    if (!dedupe.has(key)) {
      dedupe.set(key, {
        chatId: chatId ? String(chatId) : null, theirNumber,
        ticketId: ticketIdKey, createdAt: r?.createdAt || nowIso(),
        telegramConnected: r?.telegramConnected || false,
        queueEntry: r?.queueEntry || null,
      });
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, calledSeries, sent: 0, message: 'No recipients in same series' }) };
  }

  // ===== Process Recipients =====
  const results = [];
  const telegramPrepared = [];
  const telegramToResultIndex = [];
  const now = nowMs();
  const nowISO = new Date(now).toISOString();
  const firebaseUpdates = {};
  let servedCountIncrement = 0;
  const redisSetPromises = [];

  for (const [key, item] of dedupe.entries()) {
    const { theirNumber, ticketId, chatId, queueEntry } = item;
    const ticketKey = ticketId ? String(ticketId) : ticketKeyFor({ ticketId: null, chatId, theirNumber });

    // ===== Duplicate check =====
    const isMatch = theirNumber === calledFull;
    if (isMatch && ticketId) {
      const alreadySent = await checkDuplicateNotification(adminDb, tenantId, ticketId);
      if (alreadySent) {
        results.push({ chatId, theirNumber, ticketKey, action: 'skipped-duplicate' });
        continue;
      }
    }

    // ===== Load ticket =====
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`tenant:${tenantId}:ticket:${ticketKey}`);
    } else {
      ticket = store.tickets?.[ticketKey] || null;
    }

    if (!ticket) {
      const createdAtISO = queueEntry?.connectedAt || queueEntry?.createdAt || queueEntry?.timestamp || item.createdAt || nowISO;
      let createdAtMs = queueEntry?.timestamp || NaN;
      if (!createdAtMs || isNaN(createdAtMs)) {
        const n = Number(createdAtISO);
        if (!isNaN(n)) createdAtMs = n < 1e12 ? n * 1000 : n;
        else { const d = new Date(createdAtISO); createdAtMs = isNaN(d.getTime()) ? Date.now() : d.getTime(); }
      }
      ticket = {
        ticketKey, ticketId: ticketId || null, chatId: chatId || null,
        theirNumber, series: seriesOf(theirNumber) || calledSeries,
        createdAt: createdAtISO, createdAtMs,
        expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
        notifiedStayAt: null, calledAt: null, servedAt: null,
      };
    } else {
      if (!ticket.createdAtMs) {
        let cand = ticket.createdAt;
        let createdMs = typeof cand === 'number' ? cand : NaN;
        if (isNaN(createdMs) && typeof cand === 'string') {
          const n = Number(cand);
          createdMs = !isNaN(n) ? n : new Date(cand).getTime();
        }
        if (!isNaN(createdMs) && createdMs < 1e12) createdMs *= 1000;
        ticket.createdAtMs = !isNaN(createdMs) ? createdMs : Date.now();
      }
    }

    if (ticket?.servedAt) {
      results.push({ chatId, theirNumber, ticketKey, action: 'skipped-already-served' });
      continue;
    }

    const behind = !isMatch && isBehindCalled(theirNumber, calledFull);
    if (!isMatch && !behind) {
      results.push({ chatId, theirNumber, ticketKey, action: 'skipped-ahead' });
      continue;
    }

    const createdMs = ticket.createdAtMs || Date.now();
    const ageMs = now - createdMs;
    if (ageMs > MAX_AGE_MS && !isMatch && ticket.ticketId) {
      firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/status`] = 'cancelled';
      results.push({ chatId, theirNumber, ticketKey, action: 'cancelled-stale' });
      ticket.expiresAt = new Date(now).toISOString();
      if (useRedis) redisSetPromises.push(redisSet(`tenant:${tenantId}:ticket:${ticketKey}`, ticket));
      else { store.tickets = store.tickets || {}; store.tickets[ticketKey] = ticket; storeDirty.dirty = true; }
      continue;
    }

    // ===== Build Message =====
    const vars = { ...templateVars, theirNumber };
    let text;
    if (isMatch) {
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      ticket.servedAtMs = now;
      text = renderTemplate(tpl.calledMessage || DEFAULT_TEMPLATES.calledMessage, vars);
      if (tpl.includeFooter !== false && tpl.footerText) {
        text += '\n\n' + renderTemplate(tpl.footerText, vars);
      }
      if (ticket.ticketId) {
        const serviceMs = Math.max(0, now - createdMs);

        // Update queue status to 'completed' (not 'served')
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/status`] = 'completed';
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/completedAt`] = now;
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/updatedAt`] = now;
        markNotificationSent(adminDb, tenantId, ticket.ticketId, firebaseUpdates);

        // Push analytics service event with ALL required fields
        await pushServiceEventTenant(adminDb, tenantId, {
          type: 'service_completed',
          serviceMs: serviceMs,           // MUST be a number — critical
          startedAt: createdMs,           // when the ticket was created/started
          completedAt: now,               // when service was completed
          timestamp: now,                 // event timestamp
          counterId: counterId || '',     // counter ID
          counter: counterName || '',     // counter name
          queueId: ticket.ticketId,       // queue entry ID
          queueNumber: theirNumber,       // the ticket number (e.g. COFFEE001)
          tenantId: tenantId,
          slug: slug || tenantId,
          sessionId: payloadSessionId || '',
          userAgent: payload.userAgent || 'server',
          platform: payload.platform || 'netlify-function',
          series: ticket.series || calledSeries,
        });
      }
      // Update stats
      const series = ticket.series || calledSeries;
      const sstats = await loadSeriesStats(tenantId, series, store);
      const serviceMsVal = Math.max(0, now - createdMs);
      sstats.totalServed = (sstats.totalServed || 0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs || 0) + serviceMsVal;
      sstats.minServiceMs = sstats.minServiceMs === null ? serviceMsVal : Math.min(sstats.minServiceMs, serviceMsVal);
      sstats.maxServiceMs = sstats.maxServiceMs === null ? serviceMsVal : Math.max(sstats.maxServiceMs, serviceMsVal);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMsVal);
      if (sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      await saveSeriesStats(tenantId, series, sstats, store, storeDirty);
      servedCountIncrement += 1;
    } else {
      // Reminder
      ticket.calledAt = ticket.calledAt || nowISO;
      ticket.notifiedStayAt = nowISO;
      ticket.lastReminderMs = now;
      text = renderTemplate(tpl.reminderMessage || DEFAULT_TEMPLATES.reminderMessage, vars);
      if (tpl.includeFooter !== false && tpl.footerText) {
        text += '\n\n' + renderTemplate(tpl.footerText, vars);
      }
      if (ticket.ticketId) {
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/lastReminderAt`] = now;
      }
    }

    // Privacy cleanup for Telegram-connected users
    if (ticket.ticketId && (item.telegramConnected || ticket.chatId)) {
      Object.assign(firebaseUpdates, markNumberForDeletionTenant(tenantId, ticket.ticketId));
    }

    // Persist ticket
    if (useRedis) redisSetPromises.push(redisSet(`tenant:${tenantId}:ticket:${ticketKey}`, ticket));
    else { store.tickets = store.tickets || {}; store.tickets[ticketKey] = ticket; storeDirty.dirty = true; }

    const resEntry = { chatId, theirNumber, ticketKey, action: isMatch ? 'served' : 'reminder' };
    results.push(resEntry);

    if (chatId) {
      const btnLabel = tpl.buttonLabel || DEFAULT_TEMPLATES.buttonLabel;
      const btnUrl = tpl.buttonUrl || DEFAULT_TEMPLATES.buttonUrl;
      const pref = tgPrepareMessage(chatId, text, btnLabel, btnUrl, extraInlineButtons);
      telegramPrepared.push(pref);
      telegramToResultIndex.push(results.length - 1);
    } else {
      results[results.length - 1].sendRes = { ok: false, reason: 'no-chatId' };
    }
  }

  // ===== Send Telegram in parallel =====
  if (telegramPrepared.length) {
    const telegramResults = await Promise.allSettled(telegramPrepared.map(p => tgSendPrepared(p)));
    telegramResults.forEach((r, i) => {
      const idx = telegramToResultIndex[i];
      results[idx].sendRes = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason };
    });
  }

  // ===== Redis batch =====
  if (redisSetPromises.length) {
    try { await Promise.allSettled(redisSetPromises); } catch (e) { console.warn('redisSet batch', e?.message); }
  }

  // ===== Firebase batch update =====
  if (Object.keys(firebaseUpdates).length > 0) {
    try {
      if (servedCountIncrement > 0) {
        let currentServed = 0;
        if (adminDb) {
          const snap = await adminDb.ref(`tenants/${tenantId}/analytics/servedCount`).get().catch(() => null);
          currentServed = snap?.val?.() || 0;
        } else if (DATABASE_URL) {
          const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/servedCount.json`);
          currentServed = res.ok ? (await res.json() || 0) : 0;
        }
        firebaseUpdates[`tenants/${tenantId}/analytics/servedCount`] = currentServed + servedCountIncrement;
      }
      if (adminDb) {
        await adminDb.ref().update(firebaseUpdates);
      } else if (DATABASE_URL) {
        await fetch(`${DATABASE_URL}.json`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(firebaseUpdates),
        });
      }
    } catch (e) { console.warn('Firebase batch update failed', e?.message); }
  }

  // ===== Save store =====
  if (!useRedis && storeDirty.dirty) {
    try { await saveStore(store, tenantId); } catch (e) { console.warn('saveStore failed', e?.message); }
  }

  // ===== Stats Snapshot =====
  const statsSnapshot = { series: calledSeries, totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: 0 };
  try {
    const s = useRedis ? await redisGet(`stats:${tenantId}:${calledSeries}`) : store?.stats?.[calledSeries];
    if (s) {
      statsSnapshot.totalServed = s.totalServed || 0;
      statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
      statsSnapshot.minServiceMs = s.minServiceMs || null;
      statsSnapshot.maxServiceMs = s.maxServiceMs || null;
      statsSnapshot.movingAvgServiceMsLast10 = s.movingAvgServiceMsLast10?.length
        ? Math.round(s.movingAvgServiceMsLast10.reduce((a, b) => a + b, 0) / s.movingAvgServiceMsLast10.length)
        : 0;
    } else {
      if (adminDb) {
        const snap = await adminDb.ref(`tenants/${tenantId}/analytics/servedCount`).get().catch(() => null);
        statsSnapshot.totalServed = snap?.val?.() || 0;
      } else if (DATABASE_URL) {
        const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/servedCount.json`);
        statsSnapshot.totalServed = res.ok ? (await res.json() || 0) : 0;
      }
    }
  } catch (e) { console.warn('statsSnapshot', e?.message); }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true, calledFull, calledSeries, counterName,
      sent: telegramPrepared.length,
      processed: results.length,
      results, statsSnapshot,
      persistence: useRedis ? 'redis' : 'ephemeral-file',
    }),
  };
};