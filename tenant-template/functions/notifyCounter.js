'use strict';

// tenant-aware notifyCounter.optimized.js
// - All DB reads/writes are scoped to tenants/{tenantId}/...
// - Uses firebase-admin when available, fallback to REST tenant-scoped paths
// - Preserves performance optimizations (single preload, in-memory builds, Promise.allSettled for telegram sends)

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');
const path = require('path');
const REDIS_URL = process.env.REDIS_URL || null;

let useRedis = false;
let RedisClient = null;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis not available, falling back to ephemeral store:', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');
const TMP_STORE = '/tmp/queuejoy_store.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MOVING_AVG_COUNT = 10; // for last N tickets

// ---------- Helpers ----------
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
const ticketKeyFor = ({ ticketId, chatId, theirNumber }) => (ticketId ? String(ticketId) : `${String(chatId)}|${normalizeNumber(theirNumber)}`);

// ---------- Store Helpers (single-write optimization) ----------
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
async function redisGet(key) { if (!RedisClient) return null; try { const v = await RedisClient.get(key); return v ? JSON.parse(v) : null; } catch (e) { console.warn('redisGet', e.message); return null; } }
async function redisSet(key, val) { if (!RedisClient) return; try { await RedisClient.set(key, JSON.stringify(val)); } catch (e) { console.warn('redisSet', e.message); } }
async function redisDel(key) { if (!RedisClient) return; try { await RedisClient.del(key); } catch (e) { console.warn('redisDel', e.message); } }

// ---------- Firebase Admin init helper ----------
function tryInitAdmin() {
  let admin = null;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    return { ok: false, reason: 'firebase-admin-not-installed', detail: String(e || '') };
  }

  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  // read service account from env
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try {
      const maybe = Buffer.from(raw, 'base64').toString('utf8');
      sa = JSON.parse(maybe);
    } catch (e) {
      try { sa = JSON.parse(raw); } catch (e2) { sa = null; }
    }
  }

  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;

  try {
    if (sa) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        ...(dbUrl ? { databaseURL: dbUrl } : {})
      });
    } else {
      admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err && err.message ? err.message : String(err) };
  }
}

// resolve slug -> tenantId using admin DB
async function resolveTenantIdWithAdmin(admin, slugOrId) {
  const db = admin.database();
  // try slugs/{slugOrId}
  try {
    const sRef = db.ref(`slugs/${slugOrId}`);
    const sSnap = await sRef.get().catch(()=>null);
    if (sSnap && sSnap.exists && sSnap.exists()) {
      const val = sSnap.val();
      if (typeof val === 'string' && val.trim()) return { tenantId: val.trim(), source: 'slugs.value' };
      if (val && typeof val === 'object' && val.tenantId) return { tenantId: String(val.tenantId), source: 'slugs.obj' };
    }
  } catch (e) {}
  // direct tenantId check
  try {
    const tRef = db.ref(`tenants/${slugOrId}/meta`);
    const tSnap = await tRef.get().catch(()=>null);
    if (tSnap && tSnap.exists && tSnap.exists()) return { tenantId: slugOrId, source: 'direct-check' };
  } catch (e) {}
  return null;
}

// ---------- Telegram ----------
function tgPrepareMessage(chatId, text, inlineButtons = []) {
  return {
    method: 'POST',
    url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '👉 Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }]].concat(inlineButtons) }
    }),
    headers: { 'Content-Type': 'application/json' },
  };
}
async function tgSendPrepared(pref) {
  try {
    const res = await fetch(pref.url, { method: pref.method, headers: pref.headers, body: pref.body });
    const textResp = await res.text().catch(() => null);
    let json = null; try { json = textResp ? JSON.parse(textResp) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, bodyText: textResp, bodyJson: json };
  } catch (err) { return { ok: false, error: String(err) }; }
}

// ---------- Stats helpers (tenant-scoped) ----------
async function loadSeriesStats(tenantId, series, store) {
  if (useRedis) {
    const s = await redisGet(`stats:${tenantId}:${series}`);
    if (s) return s;
    return { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
  } else {
    store.stats = store.stats || {};
    return (store.stats[series] || { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] });
  }
}
async function saveSeriesStats(tenantId, series, stats, store, storeDirtyFlag) {
  if (useRedis) {
    await redisSet(`stats:${tenantId}:${series}`, stats);
  } else {
    store.stats = store.stats || {};
    store.stats[series] = stats;
    storeDirtyFlag.dirty = true;
  }
}

// ---------- Helper: fetch queue entries for series (tenant-scoped) ----------
async function fetchQueueForSeriesTenant(adminDb, tenantId, series) {
  try {
    if (adminDb) {
      const qRef = adminDb.ref(`tenants/${tenantId}/queue`);
      const snap = await qRef.orderByChild('series').equalTo(series).get().catch(()=>null);
      if (snap && snap.exists && snap.exists()) return snap.val() || {};
      return {};
    } else if (DATABASE_URL) {
      const url = `${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/queue.json?orderBy=${encodeURIComponent('"series"')}&equalTo=${encodeURIComponent('"' + series + '"')}`;
      const res = await fetch(url);
      if (!res.ok) { console.warn('fetchQueueForSeriesTenant failed', res.status); return {}; }
      return await res.json() || {};
    }
  } catch (e) { console.warn('fetchQueueForSeriesTenant error', e && e.message); }
  return {};
}

// fallback: fetch entire queue for tenant
async function fetchQueueAllTenant(adminDb, tenantId) {
  try {
    if (adminDb) {
      const snap = await adminDb.ref(`tenants/${tenantId}/queue`).get().catch(()=>null);
      if (snap && snap.exists && snap.exists()) return snap.val() || {};
      return {};
    } else if (DATABASE_URL) {
      const res = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/queue.json`);
      if (!res.ok) { console.warn('fetchQueueAllTenant failed', res.status); return {}; }
      return await res.json() || {};
    }
  } catch (e) { console.warn('fetchQueueAllTenant error', e && e.message); }
  return {};
}

// ---------- remove number helper (for telegram-connected users) ----------
function markNumberForDeletionTenant(tenantId, ticketId) {
  if (!ticketId) return {};
  const base = `/tenants/${tenantId}/queue/${ticketId}`;
  const del = {};
  // remove common number fields for privacy when user connects Telegram
  del[`${base}/number`] = null;
  del[`${base}/queueId`] = null;
  del[`${base}/ticketId`] = null;
  del[`${base}/recipientFull`] = null;
  del[`${base}/fullNumber`] = null;
  return del;
}

// ---------- push service event to tenant analytics/serviceEvents ----------
async function pushServiceEventTenant(adminDb, tenantId, evt) {
  try {
    if (adminDb) {
      await adminDb.ref(`tenants/${tenantId}/analytics/serviceEvents`).push(evt);
    } else if (DATABASE_URL) {
      await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/serviceEvents.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt)
      });
    }
  } catch (e) { console.warn('pushServiceEventTenant', e && e.message); }
}

// ---------- Main ----------
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST' }) };
  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Tenant identification: require tenantId or slug
  let tenantId = payload.tenantId ? String(payload.tenantId).trim() : '';
  const slug = payload.slug ? String(payload.slug).trim() : '';
  const init = tryInitAdmin();
  const adminOk = init.ok && init.admin;
  const adminDb = adminOk ? init.admin.database() : null;

  if (!tenantId && slug) {
    if (adminDb) {
      const resolved = await resolveTenantIdWithAdmin(init.admin, slug);
      if (resolved && resolved.tenantId) tenantId = resolved.tenantId;
    } else if (DATABASE_URL) {
      // fallback REST resolution
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

  if (!tenantId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'tenantId or slug required' }) };
  }

  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const inlineButtons = Array.isArray(payload.inlineButtons) ? payload.inlineButtons : [];

  if (!calledFull) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull required' }) };

  const calledSeries = seriesOf(calledFull);
  const normalizedCalledFull = calledFull; // already normalized

  // load ephemeral store for this tenant (only once)
  let store = null;
  let storeDirty = { dirty: false };
  if (!useRedis) store = await loadStore(tenantId);

  // Build recipients list: prefer payload.recipients
  let rawRecipients = Array.isArray(payload.recipients) ? payload.recipients.slice() : [];

  // If not provided, preload queue items for tenant & series (single fetch)
  let preloadQueue = {};
  if (!rawRecipients.length) {
    if (calledSeries) {
      preloadQueue = await fetchQueueForSeriesTenant(adminDb, tenantId, calledSeries);
    }
    if (!preloadQueue || Object.keys(preloadQueue).length === 0) {
      preloadQueue = await fetchQueueAllTenant(adminDb, tenantId);
    }

    for (const [key, q] of Object.entries(preloadQueue || {})) {
      if (!q) continue;
      if (q.status !== 'waiting') continue;
      const theirNumber = q.queueId || q.ticketId || q.number || q.queueId;
      if (!theirNumber) continue;
      if (calledSeries && seriesOf(theirNumber) !== calledSeries) continue;
      rawRecipients.push({
        chatId: q.chatId || q.chat_id || null,
        theirNumber: theirNumber,
        ticketId: key,
        createdAt: q.timestamp || q.connectedAt || q.createdAt || null,
        telegramConnected: q.telegramConnected || q.telegram_connected || false,
        queueEntry: q // attach full entry for use without extra fetch
      });
    }
  }

  // dedupe normalized recipients and precompute values to avoid repeated work
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id || null;
    const theirNumberRaw = r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || r?.ticketNumber || '';
    const theirNumber = normalizeNumber(theirNumberRaw);
    if (!theirNumber) continue;
    const ticketIdKey = r?.ticketId || r?.queueKey || null;
    const key = ticketKeyFor({ ticketId: ticketIdKey, chatId, theirNumber });
    if (!dedupe.has(key)) {
      dedupe.set(key, {
        chatId: chatId ? String(chatId) : null,
        theirNumber,
        ticketId: ticketIdKey,
        createdAt: r?.createdAt || nowIso(),
        telegramConnected: r?.telegramConnected || false,
        queueEntry: r?.queueEntry || null
      });
    }
  }

  if (!dedupe.size) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, calledSeries, sent: 0, message: 'No recipients in same series' }) };

  const results = [];
  const telegramPrepared = [];
  const telegramToResultIndex = [];
  const now = nowMs();
  const nowISO = new Date(now).toISOString();
  const firebaseUpdates = {}; // batch patch body (tenant-scoped keys)
  let servedCountIncrement = 0;

  // For Redis, collect set ops and run them in parallel at the end
  const redisSetPromises = [];

  // iterate recipients
  for (const [key, item] of dedupe.entries()) {
    const { theirNumber, ticketId, chatId, queueEntry } = item;
    const ticketKey = ticketId ? String(ticketId) : ticketKeyFor({ ticketId: null, chatId, theirNumber });

    // load persisted ticket if present (from redis or file store)
    let ticket = null;
    if (useRedis) {
      try { ticket = await redisGet(`tenant:${tenantId}:ticket:${ticketKey}`); } catch (e) { ticket = null; }
    } else {
      ticket = (store.tickets && store.tickets[ticketKey]) || null;
    }

    // build fallback ticket from preloaded queueEntry (no extra fetch)
    if (!ticket) {
      const createdAtISO = (queueEntry && (queueEntry.connectedAt || queueEntry.createdAt || queueEntry.timestamp)) || item.createdAt || nowISO;
      let createdAtMs = queueEntry?.timestamp || NaN;
      if (!createdAtMs) {
        if (createdAtISO) {
          const n = Number(createdAtISO);
          if (!isNaN(n)) createdAtMs = n < 1e12 ? n * 1000 : n;
          else {
            const d = new Date(createdAtISO);
            if (!isNaN(d.getTime())) createdAtMs = d.getTime();
          }
        }
      }
      if (!createdAtMs || isNaN(createdAtMs)) createdAtMs = Date.now();

      ticket = {
        ticketKey,
        ticketId: ticketId || null,
        chatId: chatId || null,
        theirNumber,
        series: seriesOf(theirNumber) || calledSeries,
        createdAt: createdAtISO,
        createdAtMs,
        expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
        notifiedStayAt: null,
        calledAt: null,
        servedAt: null,
      };
    } else {
      if (!ticket.createdAtMs) {
        let cand = ticket.createdAt;
        let createdMs = NaN;
        if (typeof cand === 'number') createdMs = cand;
        else if (typeof cand === 'string') {
          const n = Number(cand);
          if (!isNaN(n)) createdMs = n;
          else {
            const d = new Date(cand);
            createdMs = isNaN(d.getTime()) ? NaN : d.getTime();
          }
        }
        if (!isNaN(createdMs) && createdMs < 1e12) createdMs = createdMs * 1000;
        ticket.createdAtMs = !isNaN(createdMs) ? createdMs : Date.now();
      }
    }

    if (ticket && ticket.servedAt) {
      results.push({ chatId, theirNumber, ticketKey, action: 'skipped-already-served', reason: 'ticket.servedAt present' });
      continue;
    }

    const isMatch = theirNumber === normalizedCalledFull;
    const behind = !isMatch && isBehindCalled(theirNumber, normalizedCalledFull);

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

      if (useRedis) {
        redisSetPromises.push(redisSet(`tenant:${tenantId}:ticket:${ticketKey}`, ticket));
      } else {
        store.tickets = store.tickets || {};
        store.tickets[ticketKey] = ticket;
        storeDirty.dirty = true;
      }
      continue;
    }

    // Build message and update state
    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    if (isMatch) {
      // mark served
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      ticket.servedAtMs = now;
      text = `🎯 Dear customer,\n\nYour number <b>${normalizedCalledFull}</b> has been called. Please proceed to <b>${counterName || 'the counter'}</b>. Thank you.${exploreSuffix}`;
      if (ticket.ticketId) {
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/status`] = 'served';
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/servedAt`] = now;
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
        // push service event (fire-and-forget)
        pushServiceEventTenant(adminDb, tenantId, { ticketId: ticket.ticketId, requestedAt: ticket.createdAtMs || createdMs, servedAt: now, serviceMs, counter: counterName || null, series: ticket.series || calledSeries });
      } else {
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        pushServiceEventTenant(adminDb, tenantId, { ticketId: null, requestedAt: ticket.createdAtMs || createdMs, servedAt: now, serviceMs, counter: counterName || null, series: ticket.series || calledSeries });
      }

      // update series stats in-memory (deferred write)
      const series = ticket.series || calledSeries;
      const sstats = await loadSeriesStats(tenantId, series, store);
      const serviceMsVal = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
      sstats.totalServed = (sstats.totalServed || 0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs || 0) + serviceMsVal;
      sstats.minServiceMs = (sstats.minServiceMs === null) ? serviceMsVal : Math.min(sstats.minServiceMs, serviceMsVal);
      sstats.maxServiceMs = (sstats.maxServiceMs === null) ? serviceMsVal : Math.max(sstats.maxServiceMs, serviceMsVal);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMsVal);
      if (sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      await saveSeriesStats(tenantId, series, sstats, store, storeDirty);

      servedCountIncrement += 1;
    } else {
      // Reminder to someone behind the called number
      ticket.calledAt = ticket.calledAt || nowISO;
      ticket.notifiedStayAt = nowISO;
      ticket.lastReminderMs = now;
      text = `🔔 REMINDER\nNumber <b>${normalizedCalledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
      if (ticket.ticketId) {
        firebaseUpdates[`tenants/${tenantId}/queue/${ticket.ticketId}/lastReminderAt`] = now;
      }
    }

    // If ticket belongs to a Telegram-connected user, remove their number fields from Firebase for privacy
    const userTelegramConnected = !!(item?.telegramConnected || ticket?.telegramConnected || ticket?.chatId);
    if (ticket.ticketId && userTelegramConnected) {
      Object.assign(firebaseUpdates, markNumberForDeletionTenant(tenantId, ticket.ticketId));
    }

    // Persist ticket
    if (useRedis) {
      redisSetPromises.push(redisSet(`tenant:${tenantId}:ticket:${ticketKey}`, ticket));
    } else {
      store.tickets = store.tickets || {};
      store.tickets[ticketKey] = ticket;
      storeDirty.dirty = true;
    }

    const resEntry = { chatId, theirNumber, ticketKey, action: isMatch ? 'served' : 'reminder' };
    results.push(resEntry);

    if (chatId) {
      const pref = tgPrepareMessage(chatId, text, inlineButtons);
      telegramPrepared.push(pref);
      telegramToResultIndex.push(results.length - 1);
    } else {
      results[results.length - 1].sendRes = { ok: false, reason: 'no-chatId' };
    }
  } // end for recipients

  // ---------- Send Telegram messages in parallel ----------
  if (telegramPrepared.length) {
    const sendPromises = telegramPrepared.map(p => tgSendPrepared(p));
    const telegramResults = await Promise.allSettled(sendPromises);
    telegramResults.forEach((r, i) => {
      const resultIndex = telegramToResultIndex[i];
      results[resultIndex].sendRes = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason };
    });
  }

  // ---------- Execute Redis sets in parallel ----------
  if (redisSetPromises.length) {
    try { await Promise.allSettled(redisSetPromises); } catch (e) { console.warn('redisSet batch failed', e && e.message); }
  }

  // ---------- Update Firebase servedCount + per-queue updates in batch (tenant-scoped) ----------
  if (Object.keys(firebaseUpdates).length > 0) {
    try {
      // update tenant-scoped served count
      if (servedCountIncrement > 0) {
        if (adminDb) {
          const countRef = adminDb.ref(`tenants/${tenantId}/analytics/servedCount`);
          const snap = await countRef.get().catch(()=>null);
          const currentServed = (snap && snap.exists && snap.val) ? snap.val() : 0;
          firebaseUpdates[`tenants/${tenantId}/analytics/servedCount`] = (currentServed || 0) + servedCountIncrement;
        } else if (DATABASE_URL) {
          const servedRes = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/servedCount.json`);
          const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
          firebaseUpdates[`tenants/${tenantId}/analytics/servedCount`] = (currentServed || 0) + servedCountIncrement;
        }
      }
      if (adminDb) {
        // adminDb.update expects object keyed by absolute paths from database root
        await adminDb.ref().update(firebaseUpdates);
      } else if (DATABASE_URL) {
        await fetch(`${DATABASE_URL}.json`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(firebaseUpdates)
        });
      }
    } catch (e) { console.warn('Firebase batch update failed', e && e.message); }
  }

  // ---------- Single write for ephemeral store (if dirty) ----------
  if (!useRedis && storeDirty.dirty) {
    try { await saveStore(store, tenantId); } catch (e) { console.warn('final saveStore failed', e && e.message); }
  }

  // ---------- Build stats snapshot for response ----------
  const statsSnapshot = { series: calledSeries, totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: 0 };
  try {
    const s = await (useRedis ? redisGet(`stats:${tenantId}:${calledSeries}`) : (store.stats && store.stats[calledSeries]));
    if (s) {
      statsSnapshot.totalServed = s.totalServed || 0;
      statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
      statsSnapshot.minServiceMs = s.minServiceMs || null;
      statsSnapshot.maxServiceMs = s.maxServiceMs || null;
      statsSnapshot.movingAvgServiceMsLast10 = (s.movingAvgServiceMsLast10 && s.movingAvgServiceMsLast10.length)
        ? Math.round(s.movingAvgServiceMsLast10.reduce((a, b) => a + b, 0) / s.movingAvgServiceMsLast10.length)
        : 0;
    } else {
      if (adminDb) {
        const snap = await adminDb.ref(`tenants/${tenantId}/analytics/servedCount`).get().catch(()=>null);
        statsSnapshot.totalServed = (snap && snap.exists && snap.val) ? snap.val() : 0;
      } else if (DATABASE_URL) {
        const servedRes = await fetch(`${DATABASE_URL}/tenants/${encodeURIComponent(tenantId)}/analytics/servedCount.json`);
        const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
        statsSnapshot.totalServed = currentServed;
      }
    }
  } catch (e) { console.warn('statsSnapshot', e && e.message); }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, calledFull: normalizedCalledFull, calledSeries, counterName, sent: results.length, results, statsSnapshot, persistence: useRedis ? 'redis' : 'ephemeral-file' })
  };
};