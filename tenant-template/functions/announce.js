'use strict';

const TELEGRAM_API = 'https://api.telegram.org';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeChatId(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length ? s : '';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function extractChatIdsDeep(node) {
  const ids = new Set();

  const walk = (value) => {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value !== 'object') return;

    if (Object.prototype.hasOwnProperty.call(value, 'chatId')) {
      const id = normalizeChatId(value.chatId);
      if (id) ids.add(id);
    }

    if (Object.prototype.hasOwnProperty.call(value, 'telegramChatId')) {
      const id = normalizeChatId(value.telegramChatId);
      if (id) ids.add(id);
    }

    if (Object.prototype.hasOwnProperty.call(value, 'id')) {
      const id = normalizeChatId(value.id);
      if (id) ids.add(id);
    }

    for (const [k, v] of Object.entries(value)) {
      if (k === 'chatId' || k === 'telegramChatId' || k === 'id') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };

  walk(node);
  return [...ids].filter(Boolean);
}

function getEnv(...keys) {
  for (const k of keys) {
    if (process.env[k]) return process.env[k];
  }
  return '';
}

function guessMimeFromName(name, fallback) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.mp4')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.ogg')) return 'audio/ogg';
  return fallback || 'application/octet-stream';
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const data = match[3] || '';
  return {
    mime,
    buffer: isBase64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8')
  };
}

function pickTelegramMethod(mediaType) {
  const t = String(mediaType || '').toLowerCase();
  if (t.startsWith('image/')) return 'sendPhoto';
  if (t.startsWith('video/')) return 'sendVideo';
  if (t.startsWith('audio/')) return 'sendAudio';
  return 'sendDocument';
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.description || text || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function rtdbRead(dbUrl, path) {
  const url = `${dbUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.json`;
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

async function rtdbPatch(dbUrl, path, value) {
  const url = `${dbUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.json`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RTDB patch failed: ${text || res.status}`);
  }
  return res.json().catch(() => null);
}

async function rtdbPost(dbUrl, path, value) {
  const url = `${dbUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RTDB post failed: ${text || res.status}`);
  }
  return res.json();
}

async function getSubscriberIds(dbUrl, tenantId) {
  const paths = [
    `tenants/${tenantId}/integrations/telegram/tokens`,
    `tenants/${tenantId}/integrations/telegram/connected`,
    `tenants/${tenantId}/integrations/telegram/chatIds`,
    `tenants/${tenantId}/integrations/telegram/subscribers`,
    `tenants/${tenantId}/telegramTokens`,
    `tenants/${tenantId}/telegramConnections`,
    `tenants/${tenantId}/telegram/connected`,
    `tenants/${tenantId}/telegram/chatIds`,
    `tenants/${tenantId}/telegram/subscribers`
  ];

  const out = new Set();

  for (const path of paths) {
    try {
      const data = await rtdbRead(dbUrl, path);
      extractChatIdsDeep(data).forEach(id => out.add(id));
    } catch (_) {}
  }

  return [...out].filter(Boolean);
}

function normalizePayload(body) {
  const payload = isObject(body) ? body : {};
  const message = cleanStr(payload.message);
  const tenantId = cleanStr(payload.tenantId);
  const slug = cleanStr(payload.slug);
  const target = isObject(payload.target) ? payload.target : { type: 'all' };
  const font = cleanStr(payload.font) || 'Inter';
  const media = cleanStr(payload.media);
  const mediaType = cleanStr(payload.mediaType);
  const mediaName = cleanStr(payload.mediaName);

  return { message, tenantId, slug, target, font, media, mediaType, mediaName };
}

async function sendTelegramText(botToken, chatId, message) {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });
}

async function sendTelegramMedia(botToken, chatId, payload) {
  const kind = pickTelegramMethod(payload.mediaType);
  const url = `${TELEGRAM_API}/bot${botToken}/${kind}`;

  const dataUrl = payload.media && payload.media.startsWith('data:') ? parseDataUrl(payload.media) : null;

  // Remote URL mode: Telegram can fetch hosted URLs directly.
  if (!dataUrl) {
    const field = kind === 'sendPhoto' ? 'photo' : kind === 'sendVideo' ? 'video' : kind === 'sendAudio' ? 'audio' : 'document';
    const body = {
      chat_id: chatId,
      caption: payload.message || ''
    };
    body[field] = payload.media;
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  // Inline data URL upload.
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', payload.message || '');

  const fileName = payload.mediaName || `announcement.${(payload.mediaType || '').split('/')[1] || 'bin'}`;
  const mime = dataUrl.mime || guessMimeFromName(fileName, payload.mediaType || 'application/octet-stream');
  const file = new Blob([dataUrl.buffer], { type: mime });

  if (kind === 'sendPhoto') form.append('photo', file, fileName);
  else if (kind === 'sendVideo') form.append('video', file, fileName);
  else if (kind === 'sendAudio') form.append('audio', file, fileName);
  else form.append('document', file, fileName);

  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok || !data || data.ok === false) {
    const err = new Error(data?.description || data?.error || text || `Telegram ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod && event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const botToken = getEnv('TELEGRAM_BOT_TOKEN');
    const dbUrl = getEnv('FIREBASE_DB_URL', 'FIREBASE_DATABASE_URL', 'DATABASE_URL');
    if (!botToken) return json(500, { error: 'Missing TELEGRAM_BOT_TOKEN' });
    if (!dbUrl) return json(500, { error: 'Missing Firebase database URL env var' });

    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (_) {
      body = {};
    }

    const { message, tenantId, slug, target, media, mediaType, mediaName } = normalizePayload(body);
    if (!tenantId) return json(400, { error: 'tenantId is required' });
    if (!message) return json(400, { error: 'message is required' });

    const announcementId = `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    let recipients = [];

    if (target.type === 'list') {
      const rawIds = Array.isArray(target.chatIds) ? target.chatIds : [];
      recipients = [...new Set(rawIds.map(normalizeChatId).filter(Boolean))];
    } else if (Array.isArray(body.telegramChatIds) && body.telegramChatIds.length) {
      recipients = [...new Set(body.telegramChatIds.map(normalizeChatId).filter(Boolean))];
    } else {
      recipients = await getSubscriberIds(dbUrl, tenantId);
    }

    if (!recipients.length) {
      await rtdbPatch(dbUrl, `tenants/${tenantId}/integrations/telegram/sentAnnouncements/${announcementId}`, {
        meta: {
          announcementId,
          tenantId,
          slug,
          message,
          mediaType: mediaType || '',
          mediaName: mediaName || '',
          target: target.type || 'all',
          success: 0,
          failed: 0,
          total: 0,
          ts: Date.now()
        }
      });

      return json(200, {
        ok: true,
        announcementId,
        success: 0,
        failed: 0,
        total: 0,
        message: 'No recipients found'
      });
    }

    const results = [];
    let success = 0;
    let failed = 0;

    for (const chatId of recipients) {
      try {
        let telegramResult;
        if (media) {
          telegramResult = await sendTelegramMedia(botToken, chatId, { media, mediaType, mediaName, message });
        } else {
          telegramResult = await sendTelegramText(botToken, chatId, message);
        }

        success += 1;
        results.push({
          chatId,
          status: 'ok',
          ts: Date.now(),
          telegram: telegramResult?.result ? true : false
        });
      } catch (err) {
        failed += 1;
        results.push({
          chatId,
          status: 'error',
          error: err && err.message ? err.message : 'send failed',
          ts: Date.now()
        });
      }
    }

    const summary = {
      meta: {
        announcementId,
        tenantId,
        slug,
        message,
        mediaType: mediaType || '',
        mediaName: mediaName || '',
        target: target.type || 'all',
        success,
        failed,
        total: recipients.length,
        ts: Date.now()
      }
    };

    // Write summary and per-chat results so admin.html can show a send log.
    const patchBody = { ...summary };
    for (const row of results) {
      patchBody[row.chatId] = row;
    }

    await rtdbPatch(dbUrl, `tenants/${tenantId}/integrations/telegram/sentAnnouncements/${announcementId}`, patchBody);

    // Optional simple analytics stream
    await rtdbPost(dbUrl, `tenants/${tenantId}/analytics/announcementLogs`, {
      announcementId,
      tenantId,
      slug,
      success,
      failed,
      total: recipients.length,
      ts: Date.now()
    }).catch(() => null);

    return json(200, {
      ok: true,
      announcementId,
      success,
      failed,
      total: recipients.length,
      results: results.slice(0, 20)
    });
  } catch (err) {
    return json(500, {
      error: err && err.message ? err.message : 'Unknown server error'
    });
  }
};