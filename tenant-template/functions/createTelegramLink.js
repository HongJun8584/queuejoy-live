'use strict';

/*
  createTelegramLink.js â€” QueueJoy Tenant-Aware Telegram Link Generator
  Netlify Serverless Function

  Writes tokens to ALL THREE paths:
    telegramTokens/{token}                                    (global lookup)
    tenants/{tenantId}/integrations/telegram/tokens/{token}   (tenant integration path)
    tenants/{tenantId}/telegramTokens/{token}                 (tenant lookup - used by webhook scan)

  Includes full metadata: queueKey, queueId, queueNumber, counterId, counterName, slug, tenantId
  Tries firebase-admin first, falls back to RTDB REST PUT
*/

const { nanoid } = require('nanoid');
const fetch = globalThis.fetch || require('node-fetch');

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 24 * 60 * 60 * 1000);

function makeHeaders(origin) {
  const CORS = process.env.ALLOWED_ORIGIN || origin || '*';
  return {
    'Access-Control-Allow-Origin': CORS,
    'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function json(status, payload, origin) {
  return { statusCode: status, headers: makeHeaders(origin), body: JSON.stringify(payload) };
}

function sanitize(v, max = 2000) {
  if (v === undefined || v === null) return '';
  const s = (typeof v === 'string') ? v.trim() : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function parseBody(event) {
  if (!event || !event.body) return {};
  try {
    return event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body);
  } catch (e) { return {}; }
}

function pickTenantCandidate(event, body) {
  if (body && (body.tenantId || body.tenant || body.slug)) return sanitize(body.tenantId || body.tenant || body.slug);
  if (event && event.queryStringParameters && event.queryStringParameters.slug) return sanitize(event.queryStringParameters.slug);
  if (event && event.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitize(low['x-tenant']);
  }
  return '';
}

/* -------- firebase-admin init -------- */
function tryInitAdmin() {
  let admin = null;
  try { admin = require('firebase-admin'); } catch (e) {
    return { ok: false, reason: 'firebase-admin-not-installed', detail: String(e || '') };
  }
  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try { const maybe = Buffer.from(raw, 'base64').toString('utf8'); sa = JSON.parse(maybe); }
    catch (e) { try { sa = JSON.parse(raw); } catch (e2) { sa = null; } }
  }
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || undefined;
  try {
    if (sa) admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err && err.message ? err.message : String(err) };
  }
}

/* -------- slug -> tenantId resolution -------- */
async function resolveTenantIdWithAdmin(admin, slugOrId) {
  const db = admin.database();
  try {
    const sSnap = await db.ref(`slugs/${slugOrId}`).get().catch(() => null);
    if (sSnap && sSnap.exists && sSnap.exists()) {
      const val = sSnap.val();
      if (typeof val === 'string' && val.trim()) return { tenantId: val.trim(), source: 'slugs.value' };
      if (val && typeof val === 'object' && (val.tenantId || val.id)) return { tenantId: String(val.tenantId || val.id), source: 'slugs.obj' };
    }
  } catch (e) {}

  try {
    const tSnap = await db.ref(`tenants/${slugOrId}/meta`).get().catch(() => null);
    if (tSnap && tSnap.exists && tSnap.exists()) return { tenantId: slugOrId, source: 'tenants.meta' };
  } catch (e) {}

  return null;
}

/* -------- main handler -------- */
exports.handler = async function (event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '*';

  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: makeHeaders(origin), body: '' };
  }

  if (!event || event.httpMethod !== 'POST') return json(405, { error: 'Only POST allowed' }, origin);

  const body = parseBody(event);
  const queueKey = sanitize(body.queueKey || '');
  const queueId = sanitize(body.queueId || body.queueKey || '');
  const queueNumber = sanitize(body.queueNumber || body.number || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const slug = sanitize(body.slug || '');
  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : sanitize(body.meta || '');

  const tenantCandidate = pickTenantCandidate(event, body);

  // Token generation
  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;
  const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || event.headers['x-nf-client-connection-ip'])) || null;

  // Full token payload â€” includes all useful context for webhook resolution
  const payload = {
    token,
    queueKey,
    queueId,
    queueNumber,
    counterId,
    counterName,
    slug,
    meta,
    createdAt,
    expiresAt,
    used: false,
    userAgent,
    ip
  };

  // Build Telegram deep-link
  const botEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
  const botUsername = String(botEnv).replace(/^@/, '').trim() || 'QueueJoyBot';
  const telegramLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;

  // Try admin SDK
  const init = tryInitAdmin();
  if (init.ok && init.admin) {
    try {
      const admin = init.admin;
      let resolved = null;

      if (tenantCandidate) {
        resolved = await resolveTenantIdWithAdmin(admin, tenantCandidate);
      }
      if (!resolved && body.tenantId) {
        resolved = { tenantId: sanitize(body.tenantId), source: 'body.tenantId' };
      }

      if (!resolved) {
        return json(400, {
          ok: false,
          error: 'tenant_not_resolved',
          note: 'Could not resolve tenant from provided slug or tenantId. Token not created.',
        }, origin);
      }

      const tenantId = resolved.tenantId;
      const fullPayload = { ...payload, tenantId };

      // Write to ALL THREE paths atomically
      const db = admin.database();
      const globalRecord = {
        tenantId, queueKey, queueId, queueNumber, token, createdAt, expiresAt,
        counterId, counterName, slug, used: false,
      };
      const updates = {};
      updates[`telegramTokens/${token}`] = globalRecord;
      updates[`tenants/${tenantId}/integrations/telegram/tokens/${token}`] = fullPayload;
      updates[`tenants/${tenantId}/telegramTokens/${token}`] = fullPayload;

      await db.ref().update(updates);

      return json(200, {
        ok: true,
        link: telegramLink,
        token,
        createdAt,
        expiresAt,
        tenant: tenantId,
        persisted: true,
        source: resolved.source,
        paths: [
          `telegramTokens/${token}`,
          `tenants/${tenantId}/integrations/telegram/tokens/${token}`,
          `tenants/${tenantId}/telegramTokens/${token}`
        ]
      }, origin);

    } catch (err) {
      console.error('createTelegramLink: admin write failed', err && (err.stack || err));
    }
  } else {
    console.warn('createTelegramLink: admin SDK unavailable:', init && init.reason ? init.reason : '(no details)');
  }

  // REST fallback
  const FIREBASE_DB_URL_RAW = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '';
  const FIREBASE_DB_URL = String(FIREBASE_DB_URL_RAW).replace(/\/$/, '');

  if (!FIREBASE_DB_URL) {
    return json(500, { ok: false, error: 'no_firebase_config', note: 'admin SDK unavailable and FIREBASE_DB_URL not set' }, origin);
  }

  if (!tenantCandidate) {
    return json(400, { ok: false, error: 'tenant_not_resolved', note: 'No tenantId or slug provided and REST fallback cannot resolve slugs' }, origin);
  }

  async function restPut(path, bodyObj) {
    const url = `${FIREBASE_DB_URL}${path}`;
    try {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
      const text = await res.text().catch(() => null);
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const fullPayload = { ...payload, tenantId: tenantCandidate };
  const globalRecord = {
    tenantId: tenantCandidate, queueKey, queueId, queueNumber, token,
    createdAt, expiresAt, counterId, counterName, slug, used: false,
  };

  // Write all three paths via REST
  const restResults = await Promise.allSettled([
    restPut(`/telegramTokens/${encodeURIComponent(token)}.json`, globalRecord),
    restPut(`/tenants/${encodeURIComponent(tenantCandidate)}/integrations/telegram/tokens/${encodeURIComponent(token)}.json`, fullPayload),
    restPut(`/tenants/${encodeURIComponent(tenantCandidate)}/telegramTokens/${encodeURIComponent(token)}.json`, fullPayload),
  ]);

  const persisted = restResults.some(r => r.status === 'fulfilled' && r.value && r.value.ok);

  return json(200, {
    ok: true,
    link: telegramLink,
    token,
    createdAt,
    expiresAt,
    tenant: tenantCandidate,
    persisted,
    note: persisted ? 'written via REST fallback to all paths' : 'REST writes may have failed'
  }, origin);
};