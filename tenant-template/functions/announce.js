'use strict';

/**
 * QueueJoy Announce — Netlify Function
 *
 * Sends a Telegram message (and optional media) to either:
 *   - all connected users for a tenant, OR
 *   - a custom list of chat IDs.
 *
 * Recipient resolution (tenant-aware) follows the actual QueueJoy schema:
 *
 *   1) /telegramChatIndex/{chatId}   — entries where .tenantId === tenantId  (preferred)
 *   2) /telegramTokens/{tokenKey}    — entries where .tenantId === tenantId AND .used === true,
 *                                      pulling .chatId
 *
 * The user-facing Telegram message is the admin's plain text — no
 * "Tenant: …" / "Level: …" / "Font: …" prefixes are injected.
 *
 * Delivery results are written to:
 *   tenants/{tenantId}/public/announcementLogs/{logId}/{chatId} = { status, error?, ts, slug, tenantId }
 *
 * The log shape is unchanged.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL    = process.env.FIREBASE_DB_URL || process.env.DATABASE_URL;

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode, data) {
  return { statusCode, headers: DEFAULT_HEADERS, body: JSON.stringify(data) };
}
function normalizeId(v) { return v == null ? '' : String(v).trim(); }
function uniq(arr) { return [...new Set((arr || []).map(normalizeId).filter(Boolean))]; }
function isProbablyChatId(v) {
  const s = normalizeId(v);
  return /^-?\d{5,}$/.test(s);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeJsonParse(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
  const text = await res.text();
  const data = safeJsonParse(text) ?? (text ? { raw: text } : null);
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message || data.description)) || `HTTP ${res.status}`);
    err.status = res.status; err.payload = data;
    throw err;
  }
  return data;
}

async function readRtdb(path) {
  if (!DB_URL) throw new Error('Missing FIREBASE_DB_URL env var');
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const base = DB_URL.replace(/\/+$/, '');
  return fetchJson(`${base}/${cleanPath}.json`, { method: 'GET' });
}

async function writeRtdb(path, value, method = 'PATCH') {
  if (!DB_URL) throw new Error('Missing FIREBASE_DB_URL env var');
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const base = DB_URL.replace(/\/+$/, '');
  return fetchJson(`${base}/${cleanPath}.json`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

/* ------------------------------------------------------------------ *
 * Recipient discovery — matches the real QueueJoy schema.
 * ------------------------------------------------------------------ */
async function getTenantChatIds(tenantId) {
  const ids = new Set();
  if (!tenantId) return [];

  // (1) Global /telegramChatIndex — filter by tenantId.
  try {
    const node = await readRtdb('telegramChatIndex');
    if (node && typeof node === 'object') {
      for (const [chatKey, entry] of Object.entries(node)) {
        if (!entry || typeof entry !== 'object') continue;
        if (normalizeId(entry.tenantId) !== tenantId) continue;
        const chatId = normalizeId(entry.chatId || chatKey);
        if (isProbablyChatId(chatId)) ids.add(chatId);
      }
    }
  } catch { /* tolerate missing path */ }

  // (2) Global /telegramTokens — filter by tenantId + used=true; pull chatId.
  try {
    const node = await readRtdb('telegramTokens');
    if (node && typeof node === 'object') {
      for (const entry of Object.values(node)) {
        if (!entry || typeof entry !== 'object') continue;
        if (normalizeId(entry.tenantId) !== tenantId) continue;
        const used = entry.used === true || entry.used === 'true' || entry.used === 1 || entry.used === '1';
        if (!used) continue;
        const chatId = normalizeId(entry.chatId);
        if (isProbablyChatId(chatId)) ids.add(chatId);
      }
    }
  } catch { /* tolerate missing path */ }

  // (3) Optional tenant-scoped fallback for backward compat.
  for (const path of [
    `tenants/${tenantId}/telegramConnected`,
    `tenants/${tenantId}/public/telegramTokens`,
  ]) {
    try {
      const node = await readRtdb(path);
      if (!node || typeof node !== 'object') continue;
      for (const [k, v] of Object.entries(node)) {
        if (isProbablyChatId(k)) ids.add(normalizeId(k));
        if (v && typeof v === 'object') {
          const used = v.used === true || v.used === 'true' || v.used === 1 || v.used === '1';
          const chatId = normalizeId(v.chatId || v.telegramChatId);
          if (chatId && (used || v.chatId || v.telegramChatId)) ids.add(chatId);
        }
      }
    } catch { /* ignore */ }
  }

  return uniq([...ids]);
}

/* ------------------------------------------------------------------ *
 * Telegram send.
 * ------------------------------------------------------------------ */
function inferMediaKind(mediaType = '', mediaName = '') {
  const mt = String(mediaType || '').toLowerCase();
  const name = String(mediaName || '').toLowerCase();
  if (mt.startsWith('image/gif') || name.endsWith('.gif') || mt.includes('gif')) return 'gif';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt) return 'document';
  return 'unknown';
}
function getTelegramMediaMethod(kind) {
  switch (kind) {
    case 'image':    return { method: 'sendPhoto',     field: 'photo' };
    case 'gif':      return { method: 'sendAnimation', field: 'animation' };
    case 'video':    return { method: 'sendVideo',     field: 'video' };
    case 'audio':    return { method: 'sendAudio',     field: 'audio' };
    default:         return { method: 'sendDocument',  field: 'document' };
  }
}
function getMediaExt(mediaType = '', mediaName = '', kind = 'document') {
  const mt = String(mediaType || '').toLowerCase();
  const name = String(mediaName || '').toLowerCase();
  if (name.endsWith('.jpg') || mt === 'image/jpeg') return 'jpg';
  if (name.endsWith('.jpeg')) return 'jpeg';
  if (name.endsWith('.png')  || mt === 'image/png') return 'png';
  if (name.endsWith('.webp') || mt === 'image/webp') return 'webp';
  if (name.endsWith('.gif')  || mt.includes('gif') || kind === 'gif') return 'gif';
  if (name.endsWith('.mp4')  || mt === 'video/mp4') return 'mp4';
  if (name.endsWith('.mov')  || mt === 'video/quicktime') return 'mov';
  if (name.endsWith('.webm') || mt === 'video/webm') return 'webm';
  if (name.endsWith('.mp3')  || mt === 'audio/mpeg') return 'mp3';
  if (name.endsWith('.ogg')  || mt === 'audio/ogg') return 'ogg';
  if (name.endsWith('.wav')  || mt === 'audio/wav') return 'wav';
  return 'bin';
}

async function postTelegramJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const data = safeJsonParse(text) ?? { raw: text };
  if (!res.ok || data.ok === false) {
    const err = new Error((data && (data.description || data.error || data.message)) || `Telegram HTTP ${res.status}`);
    err.status = res.status; err.payload = data;
    throw err;
  }
  return data;
}
async function postTelegramForm(url, form) {
  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  const data = safeJsonParse(text) ?? { raw: text };
  if (!res.ok || data.ok === false) {
    const err = new Error((data && (data.description || data.error || data.message)) || `Telegram HTTP ${res.status}`);
    err.status = res.status; err.payload = data;
    throw err;
  }
  return data;
}

async function sendTelegramMessage(chatId, text, media = null) {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
  const baseUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const safeText = String(text || '');
  const caption  = safeText.slice(0, 1024);

  if (media && media.data && media.type) {
    const kind = inferMediaKind(media.type, media.name);
    const { method, field } = getTelegramMediaMethod(kind);
    const fileBuffer = Buffer.from(String(media.data).split(',')[1] || '', 'base64');
    const ext = getMediaExt(media.type, media.name, kind);

    if (fileBuffer.length > 0) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(field, new Blob([fileBuffer], { type: media.type }), `announcement.${ext}`);
      if (caption) form.append('caption', caption);
      return await postTelegramForm(`${baseUrl}/${method}`, form);
    }
  }

  return await postTelegramJson(`${baseUrl}/sendMessage`, {
    chat_id: String(chatId),
    text: safeText,
    disable_web_page_preview: true,
  });
}

function getRetryDelayMs(err) {
  const retryAfter = Number(err && err.payload && err.payload.parameters && err.payload.parameters.retry_after || 0);
  if (retryAfter > 0) return Math.max(1200, retryAfter * 1000);
  return 1200;
}
async function sendWithRetry(chatId, text, media) {
  try { return await sendTelegramMessage(chatId, text, media); }
  catch (err) {
    const transient = err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
    if (!transient) throw err;
    await sleep(getRetryDelayMs(err));
    return await sendTelegramMessage(chatId, text, media);
  }
}

/* ------------------------------------------------------------------ *
 * Logging — shape unchanged.
 * ------------------------------------------------------------------ */
async function logAnnouncement(tenantId, slug, results) {
  if (!tenantId || !DB_URL) return null;
  const logId = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = `tenants/${tenantId}/public/announcementLogs/${logId}`;
  const payload = {};
  const ts = Date.now();
  for (const row of results) {
    payload[row.chatId] = {
      status: row.status,
      error:  row.error || null,
      ts,
      slug:   slug || null,
      tenantId,
    };
  }
  await writeRtdb(logPath, payload, 'PUT');
  return { logId, logPath };
}

/* ------------------------------------------------------------------ *
 * Handler.
 * ------------------------------------------------------------------ */
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: DEFAULT_HEADERS, body: '' };
    if (event.httpMethod && event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const body = JSON.parse(event.body || '{}');

    const tenantId = normalizeId(body.tenantId);
    const slug     = normalizeId(body.slug);
    const message  = String(body.message == null ? '' : body.message).trim();

    const target  = body.target || { type: 'all' };
    const customIds =
      Array.isArray(body.chatIds) && body.chatIds.length
        ? uniq(body.chatIds)
        : (target && target.type === 'list' && Array.isArray(target.chatIds) ? uniq(target.chatIds) : []);

    const media =
      body.media && body.mediaType
        ? { data: body.media, type: body.mediaType, name: body.mediaName || '' }
        : null;

    if (!message) return json(400, { error: 'Missing message' });

    let chatIds = customIds;
    if (!chatIds.length) {
      if (!tenantId) return json(400, { error: 'Missing tenantId or chatIds' });
      chatIds = await getTenantChatIds(tenantId);
    }

    if (!chatIds.length) {
      return json(200, {
        success: 0,
        failed:  0,
        total:   0,
        chatIds: [],
        tenantId: tenantId || null,
        slug: slug || null,
        error: 'No Telegram recipients found for this tenant.',
      });
    }

    // PLAIN TEXT — exactly what the admin typed.
    const text = message;

    let success = 0;
    let failed  = 0;
    const results = [];

    for (const chatId of chatIds) {
      try {
        await sendWithRetry(chatId, text, media);
        success++;
        results.push({ chatId, status: 'ok' });
      } catch (err) {
        failed++;
        results.push({ chatId, status: 'failed', error: err && err.message ? err.message : 'send failed' });
      }
      // Soft pacing to avoid Telegram burst limits
      if (chatIds.length > 1) await sleep(120);
    }

    let logInfo = null;
    try { if (tenantId) logInfo = await logAnnouncement(tenantId, slug, results); }
    catch { /* logging must never break sending */ }

    return json(200, {
      success,
      failed,
      total: success + failed,
      chatIds,
      tenantId: tenantId || null,
      slug: slug || null,
      logId: logInfo ? logInfo.logId : null,
    });
  } catch (err) {
    return json(500, {
      errorType: err && err.name ? err.name : 'Error',
      errorMessage: err && err.message ? err.message : 'Server error',
    });
  }
};
