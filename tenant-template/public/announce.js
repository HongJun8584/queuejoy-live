// tenant-template/functions/announce.js
'use strict';

const { setTimeout: sleep } = require('timers/promises');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.FIREBASE_DB_URL || process.env.DATABASE_URL;

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(data)
  };
}

function normalizeId(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s;
}

function uniq(arr) {
  return [...new Set(arr.map(normalizeId).filter(Boolean))];
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
  if (typeof node.id !== 'undefined' && (node.used === true || node.connected === true || node.chatId || node.telegramChatId)) {
    out.add(normalizeId(node.id));
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;
    if (v && typeof v === 'object') deepExtractChatIds(v, out);
  }

  return out;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function readRtdb(path) {
  if (!DB_URL) {
    throw new Error('Missing FIREBASE_DB_URL env var');
  }
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const url = `${DB_URL.replace(/\/+$/, '')}/${cleanPath}.json`;
  return fetchJson(url, { method: 'GET' });
}

async function writeRtdb(path, value) {
  if (!DB_URL) {
    throw new Error('Missing FIREBASE_DB_URL env var');
  }
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const url = `${DB_URL.replace(/\/+$/, '')}/${cleanPath}.json`;
  return fetchJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

async function getTenantChatIds(tenantId) {
  const ids = new Set();

  const paths = [
    `tenants/${tenantId}/telegramConnected`,
    `tenants/${tenantId}/telegramTokens`,
    `tenants/${tenantId}/integrations/telegram/tokens`
  ];

  for (const path of paths) {
    try {
      const node = await readRtdb(path);
      if (!node) continue;

      if (path.endsWith('/telegramConnected')) {
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            const keyAsId = normalizeId(k);
            if (keyAsId) ids.add(keyAsId);
            if (v && typeof v === 'object') {
              if (v.chatId) ids.add(normalizeId(v.chatId));
              if (v.telegramChatId) ids.add(normalizeId(v.telegramChatId));
            }
          }
        }
        continue;
      }

      if (path.endsWith('/telegramTokens') || path.endsWith('/integrations/telegram/tokens')) {
        if (typeof node === 'object') {
          for (const [tokenId, token] of Object.entries(node)) {
            if (!token || typeof token !== 'object') continue;

            const used = token.used === true || token.used === 'true' || token.used === 1 || token.used === '1';
            const chatId = normalizeId(token.chatId || token.telegramChatId);

            // Prefer used tokens, but include any valid chatId fallback if present.
            if (chatId && (used || token.chatId || token.telegramChatId)) {
              ids.add(chatId);
            }

            // If the record structure stores recipient ID as the key, allow that too.
            if (used && tokenId && /^\d+$/.test(String(tokenId))) {
              ids.add(String(tokenId));
            }
          }
        }
      }
    } catch {
      // Ignore one broken source and continue with the rest.
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

async function sendTelegramMessage(chatId, text, media = null) {
  if (!BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
  }

  const baseUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;

  // Media support is optional. If the admin sent media, try to send it.
  // If media fails, fall back to plain text for that recipient.
  if (media && media.data && media.type) {
    const isImage = /^image\//.test(media.type);
    const isVideo = /^video\//.test(media.type);
    const isAudio = /^audio\//.test(media.type);

    if (isImage) {
      const res = await fetch(`${baseUrl}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: media.data,
          caption: text.slice(0, 1024)
        })
      });
      if (res.ok) return await res.json();
    } else if (isVideo) {
      const res = await fetch(`${baseUrl}/sendVideo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          video: media.data,
          caption: text.slice(0, 1024)
        })
      });
      if (res.ok) return await res.json();
    } else if (isAudio) {
      const res = await fetch(`${baseUrl}/sendAudio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          audio: media.data,
          caption: text.slice(0, 1024)
        })
      });
      if (res.ok) return await res.json();
    }
  }

  // Plain text fallback
  const res = await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error((data && (data.description || data.error || data.message)) || `Telegram HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function sendWithRetry(chatId, text, media) {
  const attempt = async () => sendTelegramMessage(chatId, text, media);

  try {
    return await attempt();
  } catch (err) {
    const transient = err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
    if (!transient) throw err;
    await sleep(1200);
    return await attempt();
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== 'POST') {
      return json(405, { error: 'Method Not Allowed' });
    }

    const body = JSON.parse(event.body || '{}');

    const tenantId = normalizeId(body.tenantId);
    const slug = normalizeId(body.slug);
    const message = normalizeId(body.message);
    const font = normalizeId(body.font);
    const level = normalizeId(body.level) || 'info';

    if (!tenantId) return json(400, { error: 'Missing tenantId' });
    if (!message) return json(400, { error: 'Missing message' });

    const target = body.target || { type: 'all' };
    const customIds =
      target && target.type === 'list' && Array.isArray(target.chatIds)
        ? uniq(target.chatIds)
        : [];

    let chatIds = [];

    if (customIds.length > 0) {
      chatIds = customIds;
    } else {
      chatIds = await getTenantChatIds(tenantId);
    }

    if (!chatIds.length) {
      return json(200, {
        success: 0,
        failed: 0,
        error: 'No Telegram recipients found'
      });
    }

    const media = body.media && body.mediaType
      ? {
          data: body.media,
          type: body.mediaType,
          name: body.mediaName || ''
        }
      : null;

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
          error: err.message || 'send failed'
        });

        // If media fails for a recipient, try text fallback once more.
        if (media) {
          try {
            await sendWithRetry(chatId, text, null);
            success++;
            failed--;
            results[results.length - 1] = { chatId, status: 'ok', fallback: 'text' };
          } catch (fallbackErr) {
            results[results.length - 1] = {
              chatId,
              status: 'failed',
              error: fallbackErr.message || 'text fallback failed'
            };
          }
        }
      }
    }

    // Optional send log in Firebase
    try {
      const logId = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const logPath = `tenants/${tenantId}/integrations/telegram/sentAnnouncements/${logId}`;
      const logData = {};
      for (const row of results) {
        logData[row.chatId] = {
          status: row.status,
          error: row.error || null,
          fallback: row.fallback || null,
          ts: Date.now(),
          slug: slug || null,
          tenantId
        };
      }
      await writeRtdb(logPath, logData);
    } catch {
      // logging failure should not break send response
    }

    return json(200, {
      success,
      failed,
      chatIds,
      tenantId,
      slug
    });
  } catch (err) {
    return json(500, {
      errorType: err.name || 'Error',
      errorMessage: err.message || 'Server error',
      trace: (err.stack || '').split('\n').slice(0, 8).map(s => s.trim())
    });
  }
};