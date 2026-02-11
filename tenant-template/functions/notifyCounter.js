// tenant-template/functions/notifyCounter.js
// Optimized notifyCounter, tenant-aware
// Place in tenant-template/functions/
// Node 18+ recommended (global fetch available)

const fs = require('fs');
const path = require('path');
const fetch = globalThis.fetch || require('node-fetch');
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

// default BOT token (can be overridden per-request via payload.botToken)
const DEFAULT_BOT_TOKEN = process.env.BOT_TOKEN || null;
const DATABASE_URL = (process.env.DATABASE_URL || "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/$/, '');
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
  let s = String(n);
  s = s.trim();
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
async function loadStore() {
  if (useRedis) return null;
  try {
    if (fs.existsSync(TMP_STORE)) return JSON.parse(fs.readFileSync(TMP_STORE, 'utf8') || '{"tickets":{},"stats":{}}');
  } catch (e) { console.warn('loadStore', e.message); }
  return { tickets: {}, stats: {} };
}
async function saveStore(obj) {
  if (useRedis) return;
  try { fs.writeFileSync(TMP_STORE, JSON.stringify(obj)); } catch (e) { console.warn('saveStore', e.message); }
}
async function redisGet(key) { if (!RedisClient) return null; try { const v = await RedisClient.get(key); return v ? JSON.parse(v) : null; } catch (e) { console.warn('redisGet', e.message); return null; } }
async function redisSet(key, val) { if (!RedisClient) return; try { await RedisClient.set(key, JSON.stringify(val)); } catch (e) { console.warn('redisSet', e.message); } }
async function redisDel(key) { if (!RedisClient) return; try { await RedisClient.del(key); } catch (e) { console.warn('redisDel', e.message); } }

// ---------- Tenant helpers ----------
function sanitizeInput(v, max = 500) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function pickTenantFromEvent(event, body) {
  // priority: body.tenant | body.slug | query ?slug= | header x-tenant
  if (body && (body.tenant || body.slug)) return sanitizeInput(body.tenant || body.slug);
  try {
    if (event.queryStringParameters && event.queryStringParameters.slug) return sanitizeInput(event.queryStringParameters.slug);
  } catch (e) {}
  if (event.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitizeInput(low['x-tenant']);
  }
  return '';
}
function tenantPrefixPath(slug) {
  if (!slug) return '';
  // ensure safe slug (lowercase, allowed chars)
  return `tenants/${String(slug).toString().trim()}`;
}
function dbJsonUrlFor(relPath, tenantSlug) {
  // relPath expected WITHOUT leading slash, e.g. "queue.json" or "analytics/servedCount.json"
  const prefix = tenantSlug ? `${tenantPrefixPath(tenantSlug)}/` : '';
  return `${DATABASE_URL}/${prefix}${relPath}`.replace(/\/{2,}/g, '/');
}
function tenantRootPatchUrl(tenantSlug) {
  if (tenantSlug) return `${DATABASE_URL}/${tenantPrefixPath(tenantSlug)}.json`;
  return `${DATABASE_URL}.json`;
}

// ---------- Telegram ----------
function tgPrepareMessage(botToken, chatId, text, inlineButtons = [], exploreUrlOverride = null) {
  const exploreUrl = exploreUrlOverride || 'https://helloqueuejoy.netlify.app';
  return {
    method: 'POST',
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '👉 Explore QueueJoy', url: exploreUrl }]].concat(inlineButtons) }
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

// ---------- Stats helpers (in-memory updates; single write at end) ----------
async function loadSeriesStats(series, store) {
  if (useRedis) {
    const s = await redisGet(`stats:${series}`);
    if (s) return s;
    return { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
  } else {
    store.stats = store.stats || {};
    return store.stats[series] || { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
  }
}
async function saveSeriesStats(series, stats, store, storeDirtyFlag) {
  if (useRedis) {
    await redisSet(`stats:${series}`, stats);
  } else {
    store.stats = store.stats || {};
    store.stats[series] = stats;
    storeDirtyFlag.dirty = true;
  }
}

// ---------- Helper: fetch only series from Firebase ----------
async function fetchQueueForSeries(series, tenantSlug) {
  try {
    const url = dbJsonUrlFor(`queue.json?orderBy=${encodeURIComponent('"series"')}&equalTo=${encodeURIComponent('"' + series + '"')}`, tenantSlug);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('fetchQueueForSeries failed', res.status);
      return {};
    }
    const data = await res.json() || {};
    return data;
  } catch (e) {
    console.warn('fetchQueueForSeries error', e.message);
    return {};
  }
}

// fallback: fetch entire queue (only when series missing)
async function fetchQueueAll(tenantSlug) {
  try {
    const res = await fetch(dbJsonUrlFor('queue.json', tenantSlug));
    if (!res.ok) {
      console.warn('fetchQueueAll failed', res.status);
      return {};
    }
    const data = await res.json() || {};
    return data;
  } catch (e) {
    console.warn('fetchQueueAll error', e.message);
    return {};
  }
}

// ---------- remove number helper (for telegram-connected users) ----------
function markNumberForDeletion(ticketId){
  if(!ticketId) return {};
  const base = `queue/${ticketId}`;
  const del = {};
  // remove common number fields for privacy when user connects Telegram
  del[`${base}/number`] = null;
  del[`${base}/queueId`] = null;
  del[`${base}/ticketId`] = null;
  del[`${base}/recipientFull`] = null;
  del[`${base}/fullNumber`] = null;
  return del;
}

// ---------- push service event to analytics/serviceEvents ----------
async function pushServiceEvent(evt, tenantSlug) {
  try {
    const url = dbJsonUrlFor('analytics/serviceEvents.json', tenantSlug);
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt) });
  } catch (e) { console.warn('pushServiceEvent', e.message); }
}

// ---------- Main ----------
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST' }) };

  let payload;
  try { payload = event.body ? JSON.parse(event.body) : {}; } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // tenant-awareness
  const tenantSlug = pickTenantFromEvent(event, payload) || '';
  const tenantPrefix = tenantSlug ? tenantPrefixPath(tenantSlug) : '';

  // allow request-local bot token override (keeps old env behavior as default)
  const BOT_TOKEN = payload.botToken ? String(payload.botToken) : DEFAULT_BOT_TOKEN;
  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const inlineButtons = Array.isArray(payload.inlineButtons) ? payload.inlineButtons : [];
  const exploreUrl = payload.exploreUrl ? String(payload.exploreUrl).trim() : null;

  if (!calledFull) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull required' }) };

  const calledSeries = seriesOf(calledFull);
  const normalizedCalledFull = calledFull; // already normalized

  // load ephemeral store if needed (only once)
  let store = null;
  let storeDirty = { dirty: false };
  if (!useRedis) store = await loadStore();

  // Build recipients list: prefer payload.recipients
  let rawRecipients = Array.isArray(payload.recipients) ? payload.recipients.slice() : [];

  // If not provided, preload queue items for series (single fetch)
  let preloadQueue = {};
  if (!rawRecipients.length) {
    if (calledSeries) {
      preloadQueue = await fetchQueueForSeries(calledSeries, tenantSlug);
    }
    if (!preloadQueue || Object.keys(preloadQueue).length === 0) {
      preloadQueue = await fetchQueueAll(tenantSlug);
    }

    for (const [key, q] of Object.entries(preloadQueue || {})) {
      if (!q) continue;
      if (q.status && q.status !== 'waiting') continue;
      const theirNumber = q.ticketNumber || q.queueId || q.number || q.ticket || q.id || null;
      if (!theirNumber) continue;
      // if calledSeries exists, ensure we only pick same series
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
  const firebaseUpdates = {}; // batch patch body
  let servedCountIncrement = 0;

  // For Redis, collect set ops and run them in parallel at the end
  const redisSetPromises = [];

  // iterate recipients (processing only; no remote fetch inside loop)
  for (const [key, item] of dedupe.entries()) {
    const { theirNumber, ticketId, chatId, queueEntry } = item;
    const ticketKey = ticketId ? String(ticketId) : ticketKeyFor({ ticketId: null, chatId, theirNumber });

    // load persisted ticket if present (from redis or file store)
    let ticket = null;
    if (useRedis) {
      try { ticket = await redisGet(`ticket:${ticketKey}`); } catch (e) { ticket = null; }
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
      // Cancel stale ticket
      const relativeKey = `queue/${ticket.ticketId}/status`;
      firebaseUpdates[`/${relativeKey}`] = 'cancelled';
      results.push({ chatId, theirNumber, ticketKey, action: 'cancelled-stale' });
      ticket.expiresAt = new Date(now).toISOString();

      if (useRedis) {
        redisSetPromises.push(redisSet(`ticket:${ticketKey}`, ticket));
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
        firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'served';
        firebaseUpdates[`/queue/${ticket.ticketId}/servedAt`] = now;
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        firebaseUpdates[`/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
        // push service event (fire-and-forget)
        pushServiceEvent({ ticketId: ticket.ticketId, requestedAt: ticket.createdAtMs || createdMs, servedAt: now, serviceMs, counter: counterName || null, series: ticket.series || calledSeries }, tenantSlug);
      } else {
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        pushServiceEvent({ ticketId: null, requestedAt: ticket.createdAtMs || createdMs, servedAt: now, serviceMs, counter: counterName || null, series: ticket.series || calledSeries }, tenantSlug);
      }

      // update series stats in-memory (deferred write)
      const series = ticket.series || calledSeries;
      const sstats = await loadSeriesStats(series, store);
      const serviceMsVal = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
      sstats.totalServed = (sstats.totalServed || 0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs || 0) + serviceMsVal;
      sstats.minServiceMs = (sstats.minServiceMs === null) ? serviceMsVal : Math.min(sstats.minServiceMs, serviceMsVal);
      sstats.maxServiceMs = (sstats.maxServiceMs === null) ? serviceMsVal : Math.max(sstats.maxServiceMs, serviceMsVal);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMsVal);
      if (sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      await saveSeriesStats(series, sstats, store, storeDirty);

      servedCountIncrement += 1;
    } else {
      // Reminder to someone behind the called number
      ticket.calledAt = ticket.calledAt || nowISO;
      ticket.notifiedStayAt = nowISO;
      ticket.lastReminderMs = now;
      text = `🔔 REMINDER\nNumber <b>${normalizedCalledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
      if (ticket.ticketId) {
        firebaseUpdates[`/queue/${ticket.ticketId}/lastReminderAt`] = now;
      }
    }

    // If ticket belongs to a Telegram-connected user, remove their number fields from Firebase for privacy
    const userTelegramConnected = !!(item?.telegramConnected || ticket?.telegramConnected || ticket?.chatId);
    if (ticket.ticketId && userTelegramConnected) {
      Object.assign(firebaseUpdates, markNumberForDeletion(ticket.ticketId));
    }

    // Persist ticket (defer file write; collect redis promises)
    if (useRedis) {
      redisSetPromises.push(redisSet(`ticket:${ticketKey}`, ticket));
    } else {
      store.tickets = store.tickets || {};
      store.tickets[ticketKey] = ticket;
      storeDirty.dirty = true;
    }

    const resEntry = { chatId, theirNumber, ticketKey, action: isMatch ? 'served' : 'reminder' };
    results.push(resEntry);

    if (chatId) {
      const pref = tgPrepareMessage(BOT_TOKEN, chatId, text, inlineButtons, exploreUrl);
      telegramPrepared.push(pref);
      telegramToResultIndex.push(results.length - 1);
    } else {
      results[results.length - 1].sendRes = { ok: false, reason: 'no-chatId' };
    }
  } // end for recipients

  // ---------- Send Telegram messages in parallel ----------
  if (telegramPrepared.length) {
    // Option: chunk to avoid large parallel requests. We'll send parallel but left as-is (same behavior).
    const sendPromises = telegramPrepared.map(p => tgSendPrepared(p));
    const telegramResults = await Promise.allSettled(sendPromises);
    telegramResults.forEach((r, i) => {
      const resultIndex = telegramToResultIndex[i];
      results[resultIndex].sendRes = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason };
    });
  }

  // ---------- Execute Redis sets in parallel ----------
  if (redisSetPromises.length) {
    try { await Promise.allSettled(redisSetPromises); } catch (e) { console.warn('redisSet batch failed', e.message); }
  }

  // ---------- Update Firebase servedCount + per-queue updates in batch ----------
  if (Object.keys(firebaseUpdates).length > 0) {
    try {
      // read current servedCount (tenant-scoped)
      const servedCountUrl = dbJsonUrlFor('analytics/servedCount.json', tenantSlug);
      const servedRes = await fetch(servedCountUrl);
      const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
      if (servedCountIncrement > 0) {
        // when patching tenant root, keys like '/analytics/servedCount' are relative to root
        firebaseUpdates['/analytics/servedCount'] = currentServed + servedCountIncrement;
      }
      // patch at tenant root (or global root if tenant not specified)
      const patchUrl = tenantRootPatchUrl(tenantSlug);
      await fetch(patchUrl, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(firebaseUpdates)
      });
    } catch (e) { console.warn('Firebase batch update failed', e.message); }
  }

  // ---------- Single write for ephemeral store (if dirty) ----------
  if (!useRedis && storeDirty.dirty) {
    try { await saveStore(store); } catch (e) { console.warn('final saveStore failed', e.message); }
  }

  // ---------- Build stats snapshot for response ----------
  const statsSnapshot = { series: calledSeries, totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: 0 };
  try {
    const s = await (useRedis ? redisGet(`stats:${calledSeries}`) : (store.stats && store.stats[calledSeries]));
    if (s) {
      statsSnapshot.totalServed = s.totalServed || 0;
      statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
      statsSnapshot.minServiceMs = s.minServiceMs || null;
      statsSnapshot.maxServiceMs = s.maxServiceMs || null;
      statsSnapshot.movingAvgServiceMsLast10 = (s.movingAvgServiceMsLast10 && s.movingAvgServiceMsLast10.length)
        ? Math.round(s.movingAvgServiceMsLast10.reduce((a, b) => a + b, 0) / s.movingAvgServiceMsLast10.length)
        : 0;
    } else {
      const servedRes = await fetch(dbJsonUrlFor('analytics/servedCount.json', tenantSlug));
      const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
      statsSnapshot.totalServed = currentServed;
    }
  } catch (e) { console.warn('statsSnapshot', e.message); }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, calledFull: normalizedCalledFull, calledSeries, counterName, sent: results.length, results, statsSnapshot, persistence: useRedis ? 'redis' : 'ephemeral-file', tenant: tenantSlug || null })
  };
};
