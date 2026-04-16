'use strict';

/**
 * QueueJoy Announce Function
 * - Tenant-aware by default
 * - Also supports direct chatIds mode for manual testing
 * - Sends text, image, GIF, video, audio, and fallback document
 * - Handles CORS + OPTIONS
 * - Logs delivery results to Firebase RTDB when tenantId is present
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.FIREBASE_DB_URL || process.env.DATABASE_URL;
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode, data) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(data),
  };
}

function normalizeId(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function uniq(arr) {
  return [...new Set((arr || []).map(normalizeId).filter(Boolean))];
}

function isProbablyChatId(v) {
  const s = normalizeId(v);
  return /^\d+$/.test(s) || /^-?\d{5,}$/.test(s);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  const data = safeJsonParse(text) ?? (text ? { raw: text } : null);

  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message || data.description)) || `HTTP ${res.status}`
    );
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function readRtdb(path) {
  if (!DB_URL) throw new Error('Missing FIREBASE_DB_URL env var');

  const cleanPath = String(path || '').replace(/^\/+/, '');
  const base = DB_URL.replace(/\/+$/, '');
  const url = `${base}/${cleanPath}.json`;

  return fetchJson(url, { method: 'GET' });
}

async function writeRtdb(path, value, method = 'PATCH') {
  if (!DB_URL) throw new Error('Missing FIREBASE_DB_URL env var');

  const cleanPath = String(path || '').replace(/^\/+/, '');
  const base = DB_URL.replace(/\/+$/, '');
  const url = `${base}/${cleanPath}.json`;

  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function deepExtractChatIds(node, out = new Set()) {
  if (!node) return out;

  if (Array.isArray(node)) {
    for (const item of node) deepExtractChatIds(item, out);
    return out;
  }

  if (typeof node !== 'object') return out;

  if (typeof node.chatId !== 'undefined') out.add(normalizeId(node.chatId));
  if (typeof node.telegramChatId !== 'undefined') out.add(normalizeId(node.telegramChatId));
  if (typeof node.id !== 'undefined' && isProbablyChatId(node.id)) out.add(normalizeId(node.id));

  for (const [k, v] of Object.entries(node)) {
    if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;

    if (isProbablyChatId(k) && (v === true || v === 'true' || v === 1 || v === '1')) {
      out.add(normalizeId(k));
    }

    if (v && typeof v === 'object') deepExtractChatIds(v, out);
  }

  return out;
}

async function getTenantChatIds(tenantId) {
  const ids = new Set();

  const paths = [
    `tenants/${tenantId}/telegramConnected`,
    `tenants/${tenantId}/public/telegramTokens`,
    `tenants/${tenantId}/telegramTokens`,
    `tenants/${tenantId}/public/telegramChatIds`,
    `tenants/${tenantId}/telegramChatIds`,
    `tenants/${tenantId}/public/telegramSubscribers`,
    `tenants/${tenantId}/telegramSubscribers`,
  ];

  for (const path of paths) {
    try {
      const node = await readRtdb(path);
      if (!node) continue;

      if (path.endsWith('/telegramConnected')) {
        if (typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            if (isProbablyChatId(key)) ids.add(normalizeId(key));
            if (value && typeof value === 'object') {
              if (value.chatId) ids.add(normalizeId(value.chatId));
              if (value.telegramChatId) ids.add(normalizeId(value.telegramChatId));
            }
          }
        }
        continue;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          if (isProbablyChatId(item)) ids.add(normalizeId(item));
          if (item && typeof item === 'object') deepExtractChatIds(item, ids);
        }
        continue;
      }

      if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (isProbablyChatId(key) && (value === true || value === 'true' || value === 1 || value === '1' || value == null)) {
            ids.add(normalizeId(key));
          }

          if (value && typeof value === 'object') {
            const used =
              value.used === true ||
              value.used === 'true' ||
              value.used === 1 ||
              value.used === '1';

            const chatId = normalizeId(value.chatId || value.telegramChatId);

            if (chatId && (used || value.chatId || value.telegramChatId)) {
              ids.add(chatId);
            }

            if (value.meta && typeof value.meta === 'object') {
              if (value.meta.chatId) ids.add(normalizeId(value.meta.chatId));
              if (value.meta.telegramChatId) ids.add(normalizeId(value.meta.telegramChatId));
            }
          }
        }

        deepExtractChatIds(node, ids);
      }
    } catch {
      // Ignore one broken source and continue.
    }
  }

  return uniq([...ids]);
}

function buildTelegramText(message, payload = {}) {
  const parts = [];

  if (payload.slug) parts.push(`Tenant: ${payload.slug}`);
  if (payload.level) parts.push(`Level: ${payload.level}`);
  if (payload.font) parts.push(`Font: ${payload.font}`);

  parts.push(String(message || '').trim());
  return parts.filter(Boolean).join('\n\n');
}

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
    case 'image':
      return { method: 'sendPhoto', field: 'photo' };
    case 'gif':
      return { method: 'sendAnimation', field: 'animation' };
    case 'video':
      return { method: 'sendVideo', field: 'video' };
    case 'audio':
      return { method: 'sendAudio', field: 'audio' };
    case 'document':
    default:
      return { method: 'sendDocument', field: 'document' };
  }
}

function getMediaExt(mediaType = '', mediaName = '', kind = 'document') {
  const mt = String(mediaType || '').toLowerCase();
  const name = String(mediaName || '').toLowerCase();

  if (name.endsWith('.jpg') || mt === 'image/jpeg') return 'jpg';
  if (name.endsWith('.jpeg')) return 'jpeg';
  if (name.endsWith('.png') || mt === 'image/png') return 'png';
  if (name.endsWith('.webp') || mt === 'image/webp') return 'webp';
  if (name.endsWith('.gif') || mt.includes('gif') || kind === 'gif') return 'gif';
  if (name.endsWith('.mp4') || mt === 'video/mp4') return 'mp4';
  if (name.endsWith('.mov') || mt === 'video/quicktime') return 'mov';
  if (name.endsWith('.webm') || mt === 'video/webm') return 'webm';
  if (name.endsWith('.mp3') || mt === 'audio/mpeg') return 'mp3';
  if (name.endsWith('.ogg') || mt === 'audio/ogg') return 'ogg';
  if (name.endsWith('.wav') || mt === 'audio/wav') return 'wav';
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
    const err = new Error(
      (data && (data.description || data.error || data.message)) || `Telegram HTTP ${res.status}`
    );
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function postTelegramForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });

  const text = await res.text();
  const data = safeJsonParse(text) ?? { raw: text };

  if (!res.ok || data.ok === false) {
    const err = new Error(
      (data && (data.description || data.error || data.message)) || `Telegram HTTP ${res.status}`
    );
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function sendTelegramMessage(chatId, text, media = null) {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');

  const baseUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const caption = String(text || '').slice(0, 1024);

  if (media && media.data && media.type) {
    const kind = inferMediaKind(media.type, media.name);
    const { method, field } = getTelegramMediaMethod(kind);
    const fileBuffer = Buffer.from(String(media.data).split(',')[1] || '', 'base64');
    const ext = getMediaExt(media.type, media.name, kind);

    if (fileBuffer.length > 0) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(field, new Blob([fileBuffer], { type: media.type }), `announcement.${ext}`);

      if (kind === 'gif') {
        if (caption) form.append('caption', caption);
      } else {
        if (caption) form.append('caption', caption);
      }

      return await postTelegramForm(`${baseUrl}/${method}`, form);
    }
  }

  return await postTelegramJson(`${baseUrl}/sendMessage`, {
    chat_id: String(chatId),
    text,
    disable_web_page_preview: true,
  });
}

function getRetryDelayMs(err) {
  const retryAfter = Number(err?.payload?.parameters?.retry_after || 0);
  if (retryAfter > 0) return Math.max(1200, retryAfter * 1000);
  return 1200;
}

async function sendWithRetry(chatId, text, media) {
  try {
    return await sendTelegramMessage(chatId, text, media);
  } catch (err) {
    const transient =
      err.status === 429 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504;

    if (!transient) throw err;

    await sleep(getRetryDelayMs(err));
    return await sendTelegramMessage(chatId, text, media);
  }
}

async function logAnnouncement(tenantId, slug, results) {
  if (!tenantId || !DB_URL) return null;

  const logId = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = `tenants/${tenantId}/public/announcementLogs/${logId}`;

  const logData = {};
  const ts = Date.now();

  for (const row of results) {
    logData[row.chatId] = {
      status: row.status,
      error: row.error || null,
      ts,
      slug: slug || null,
      tenantId,
    };
  }

  await writeRtdb(logPath, logData, 'PUT');
  return { logId, logPath };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: DEFAULT_HEADERS,
        body: '',
      };
    }

    if (event.httpMethod && event.httpMethod !== 'POST') {
      return json(405, { error: 'Method Not Allowed' });
    }

    const body = JSON.parse(event.body || '{}');

    const tenantId = normalizeId(body.tenantId);
    const slug = normalizeId(body.slug);
    const message = normalizeId(body.message);
    const font = normalizeId(body.font);
    const level = normalizeId(body.level) || 'info';

    const target = body.target || { type: 'all' };
    const customIds =
      Array.isArray(body.chatIds) && body.chatIds.length
        ? uniq(body.chatIds)
        : target && target.type === 'list' && Array.isArray(target.chatIds)
          ? uniq(target.chatIds)
          : [];

    const media =
      body.media && body.mediaType
        ? {
            data: body.media,
            type: body.mediaType,
            name: body.mediaName || '',
          }
        : null;

    if (!message) return json(400, { error: 'Missing message' });

    let chatIds = customIds;

    if (!chatIds.length) {
      if (!tenantId) {
        return json(400, {
          error: 'Missing tenantId or chatIds',
        });
      }
      chatIds = await getTenantChatIds(tenantId);
    }

    if (!chatIds.length) {
      return json(200, {
        success: 0,
        failed: 0,
        error: 'No Telegram recipients found',
      });
    }

    const text = buildTelegramText(message, { slug, level, font });

    let success = 0;
    let failed = 0;
    const results = [];

    for (const chatId of chatIds) {
      try {
        await sendWithRetry(chatId, text, media);
        success++;
        results.push({ chatId, status: 'ok' });
      } catch (err) {
        failed++;
        results.push({
          chatId,
          status: 'failed',
          error: err.message || 'send failed',
        });
      }

      // Small pacing delay helps avoid Telegram burst limits
      if (chatIds.length > 1) {
        await sleep(120);
      }
    }

    let logInfo = null;
    try {
      if (tenantId) {
        logInfo = await logAnnouncement(tenantId, slug, results);
      }
    } catch {
      // Logging failure should never break sending.
    }

    return json(200, {
      success,
      failed,
      chatIds,
      tenantId: tenantId || null,
      slug: slug || null,
      logId: logInfo?.logId || null,
    });
  } catch (err) {
    return json(500, {
      errorType: err.name || 'Error',
      errorMessage: err.message || 'Server error',
      trace: (err.stack || '')
        .split('\n')
        .slice(0, 8)
        .map(s => s.trim()),
    });
  }
};