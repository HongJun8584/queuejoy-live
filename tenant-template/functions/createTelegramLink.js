'use strict';

/*
  createTelegramLink.js — QueueJoy Telegram link generator
  Netlify Serverless Function

  What this fixes:
  - Resolves tenant from tenantId / slug safely
  - Generates a Telegram deep link for the current bot
  - Writes the same complete token payload to ALL 3 paths
  - Keeps queueKey separate from queueId / queueNumber
  - Supports firebase-admin first, REST fallback second
  - Stays compatible with status.html + telegramWebhook.js
*/

const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const DEFAULT_BOT_USERNAME = 'queuejoy_notify_bot';

function makeHeaders(origin) {
  const cors = process.env.ALLOWED_ORIGIN || origin || '*';
  return {
    'Access-Control-Allow-Origin': cors,
    'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(statusCode, payload, origin) {
  return {
    statusCode,
    headers: makeHeaders(origin),
    body: JSON.stringify(payload),
  };
}

function sanitize(v, max = 2000) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function parseBody(event) {
  if (!event || !event.body) return {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeToken() {
  try {
    const { nanoid } = require('nanoid');
    return nanoid(12);
  } catch {
    return crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9_-]/g, '');
  }
}

function isLikelyTenantId(v) {
  const s = sanitize(v);
  if (!s || s.includes('/') || s.length < 8) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function pickTenantCandidate(event, body) {
  if (body && (body.tenantId || body.tenant || body.slug)) {
    return sanitize(body.tenantId || body.tenant || body.slug);
  }
  if (event?.queryStringParameters?.slug) {
    return sanitize(event.queryStringParameters.slug);
  }
  if (event?.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitize(low['x-tenant']);
  }
  return '';
}

function normalizeBotUsername(raw) {
  return String(raw || DEFAULT_BOT_USERNAME).replace(/^@/, '').trim() || DEFAULT_BOT_USERNAME;
}

function tryInitAdmin() {
  let admin = null;
  try {
    admin = require('firebase-admin');
  } catch {
    return { ok: false, reason: 'firebase-admin-not-installed' };
  }

  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    null;

  let sa = null;
  if (raw) {
    try {
      sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      try {
        sa = JSON.parse(raw);
      } catch {
        sa = null;
      }
    }
  }

  const dbUrl =
    process.env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DB_URL ||
    process.env.FIREBASE_RTDB_URL ||
    undefined;

  try {
    if (sa) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        ...(dbUrl ? { databaseURL: dbUrl } : {}),
      });
    } else {
      admin.initializeApp({
        ...(dbUrl ? { databaseURL: dbUrl } : {}),
      });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err?.message || String(err) };
  }
}

async function resolveTenantIdWithAdmin(admin, candidate) {
  const db = admin.database();
  const c = sanitize(candidate);
  if (!c) return null;

  try {
    const slugSnap = await db.ref(`slugs/${c}`).get().catch(() => null);
    if (slugSnap?.exists?.()) {
      const val = slugSnap.val();
      if (typeof val === 'string' && val.trim()) {
        return { tenantId: val.trim(), source: 'slugs.value' };
      }
      if (val && typeof val === 'object' && (val.tenantId || val.id)) {
        return { tenantId: String(val.tenantId || val.id), source: 'slugs.obj' };
      }
    }
  } catch {}

  try {
    const metaSnap = await db.ref(`tenants/${c}/meta`).get().catch(() => null);
    if (metaSnap?.exists?.()) {
      return { tenantId: c, source: 'tenants.meta' };
    }
  } catch {}

  return null;
}

async function resolveTenantIdWithRest(dbUrlRaw, candidate) {
  const dbUrl = String(dbUrlRaw || '').replace(/\/$/, '');
  const c = sanitize(candidate);
  if (!dbUrl || !c) return null;

  async function getJson(path) {
    try {
      const res = await fetch(`${dbUrl}${path}`, { method: 'GET' });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  const slugRec = await getJson(`/slugs/${encodeURIComponent(c)}.json`);
  if (slugRec) {
    if (typeof slugRec === 'string' && slugRec.trim()) {
      return { tenantId: slugRec.trim(), source: 'slugs.value.rest' };
    }
    if (typeof slugRec === 'object' && (slugRec.tenantId || slugRec.id)) {
      return { tenantId: String(slugRec.tenantId || slugRec.id), source: 'slugs.obj.rest' };
    }
  }

  const metaRec = await getJson(`/tenants/${encodeURIComponent(c)}/meta.json`);
  if (metaRec) {
    return { tenantId: c, source: 'tenants.meta.rest' };
  }

  return null;
}

async function getExactQueueWithAdmin(admin, tenantId, queueKey) {
  if (!admin || !tenantId || !queueKey) return null;
  const db = admin.database();
  for (const path of [
    `tenants/${tenantId}/queue/${queueKey}`,
    `tenants/${tenantId}/public/queues/${queueKey}`,
    `tenants/${tenantId}/public/queue/${queueKey}`,
  ]) {
    try {
      const snap = await db.ref(path).get();
      if (snap?.exists?.()) return { path, entry: snap.val() || {} };
    } catch {}
  }
  return null;
}

async function getExactQueueWithRest(dbUrlRaw, tenantId, queueKey) {
  const dbUrl = String(dbUrlRaw || '').replace(/\/$/, '');
  if (!dbUrl || !tenantId || !queueKey) return null;
  for (const path of [
    `tenants/${tenantId}/queue/${queueKey}`,
    `tenants/${tenantId}/public/queues/${queueKey}`,
    `tenants/${tenantId}/public/queue/${queueKey}`,
  ]) {
    try {
      const response = await fetch(`${dbUrl}/${path.split('/').map(encodeURIComponent).join('/')}.json`, { method: 'GET' });
      if (!response.ok) continue;
      const entry = await response.json().catch(() => null);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) return { path, entry };
    } catch {}
  }
  return null;
}

function buildTokenRecord({
  token,
  tenantId,
  slug,
  queueKey,
  queueId,
  queueNumber,
  counterId,
  counterName,
  createdAt,
  expiresAt,
}) {
  return {
    token,
    tenantId,
    slug: slug || '',
    queueKey: queueKey || '',
    queueId: queueId || queueKey || '',
    queueNumber: queueNumber || queueId || queueKey || '',
    counterId: counterId || '',
    counterName: counterName || '',
    createdAt,
    expiresAt,
    used: false,
  };
}

exports.handler = async function (event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '*';

  if (event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: makeHeaders(origin), body: '' };
  }

  if (!event || event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Only POST allowed' }, origin);
  }

  const body = parseBody(event);

  const queueKey = sanitize(body.queueKey || '');
  const requestedQueueNumber = sanitize(body.queueNumber || body.number || '');
  const requestedTenantId = sanitize(body.tenantId || '');
  const requestedTenantAlias = sanitize(body.tenant || '');
  const slug = sanitize(body.slug || event?.queryStringParameters?.slug || '');
  if (slug && !/^[A-Za-z0-9_-]{1,100}$/.test(slug)) return json(400, { ok: false, error: 'invalid_tenant_slug' }, origin);
  if (!queueKey || !/^[A-Za-z0-9_-]{1,200}$/.test(queueKey)) {
    return json(400, { ok: false, error: 'invalid_queue_key' }, origin);
  }

  const init = tryInitAdmin();
  const dbUrl = String(
    process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || ''
  ).replace(/\/$/, '');
  if ((!init.ok || !init.admin) && !dbUrl) {
    return json(500, { ok: false, error: 'no_firebase_config' }, origin);
  }

  const tenantCandidate = slug || requestedTenantId || requestedTenantAlias || sanitize(pickTenantCandidate(event, body));

  let resolved = null;
  if (init.ok && init.admin) {
    if (tenantCandidate) resolved = await resolveTenantIdWithAdmin(init.admin, tenantCandidate);
  }
  if (!resolved && dbUrl && tenantCandidate) {
    resolved = await resolveTenantIdWithRest(dbUrl, tenantCandidate);
  }

  if (!resolved?.tenantId) {
    return json(400, {
      ok: false,
      error: 'tenant_not_resolved',
      note: 'Could not resolve tenant from provided slug or tenantId. Token not created.',
    }, origin);
  }

  const tenantId = resolved.tenantId;
  if (!isLikelyTenantId(tenantId)) return json(400, { ok: false, error: 'invalid_resolved_tenant' }, origin);
  if (requestedTenantId && requestedTenantId !== tenantId) {
    return json(403, { ok: false, error: 'tenant_context_mismatch' }, origin);
  }

  let queueRecord = null;
  if (init.ok && init.admin) queueRecord = await getExactQueueWithAdmin(init.admin, tenantId, queueKey);
  if (!queueRecord && dbUrl) queueRecord = await getExactQueueWithRest(dbUrl, tenantId, queueKey);
  if (!queueRecord) return json(404, { ok: false, error: 'queue_not_found' }, origin);

  const queueEntry = queueRecord.entry || {};
  if (queueEntry.tenantId && String(queueEntry.tenantId) !== tenantId) {
    return json(403, { ok: false, error: 'queue_tenant_mismatch' }, origin);
  }
  const actualQueueNumber = sanitize(queueEntry.queueNumber || queueEntry.number || queueEntry.ticketNumber || '');
  if (requestedQueueNumber && actualQueueNumber && requestedQueueNumber !== actualQueueNumber) {
    return json(409, { ok: false, error: 'queue_number_mismatch' }, origin);
  }
  const queueStatus = sanitize(queueEntry.status || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['cancelled', 'canceled', 'noshow', 'skipped'].includes(queueStatus)) {
    return json(409, { ok: false, error: 'queue_not_active' }, origin);
  }

  const queueId = sanitize(queueEntry.queueId || queueEntry.id || queueKey);
  const queueNumber = actualQueueNumber || queueId;
  const counterId = sanitize(queueEntry.counterId || queueEntry.counter || queueEntry.counter_id || '');
  const counterName = sanitize(queueEntry.counterName || '');
  const resolvedSlug = slug || sanitize(queueEntry.slug || '');
  const token = safeToken();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const botUsername = normalizeBotUsername(process.env.BOT_USERNAME || process.env.BOT_USER || DEFAULT_BOT_USERNAME);
  const telegramLink = `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;

  const tokenPayload = buildTokenRecord({
    token,
    tenantId,
    slug: resolvedSlug,
    queueKey,
    queueId,
    queueNumber,
    counterId,
    counterName,
    createdAt,
    expiresAt,
  });

  const tokenPaths = [
    `telegramTokens/${token}`,
    `tenants/${tenantId}/integrations/telegram/tokens/${token}`,
    `tenants/${tenantId}/telegramTokens/${token}`,
  ];

  // firebase-admin write first
  if (init.ok && init.admin) {
    try {
      const db = init.admin.database();
      const updates = {};
      for (const p of tokenPaths) updates[p] = tokenPayload;
      await db.ref().update(updates);

      return json(200, {
        ok: true,
        link: telegramLink,
        createdAt,
        expiresAt,
        tenant: tenantId,
        tenantId,
        queueKey,
        queueId,
        queueNumber,
        persisted: true,
        source: resolved.source,
      }, origin);
    } catch (err) {
      console.error('[createTelegramLink] admin write failed, falling back to REST', err?.name || 'DatabaseError');
    }
  }

  // REST fallback
  const FIREBASE_DB_URL = String(
    process.env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DB_URL ||
    process.env.FIREBASE_RTDB_URL ||
    ''
  ).replace(/\/$/, '');

  if (!FIREBASE_DB_URL) {
    return json(500, {
      ok: false,
      error: 'no_firebase_config',
      note: 'Admin SDK unavailable and FIREBASE_DB_URL not set.',
    }, origin);
  }

  async function restPut(path, bodyObj) {
    const url = `${FIREBASE_DB_URL}${path}`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const text = await res.text().catch(() => null);
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const restResults = await Promise.allSettled(
    tokenPaths.map((p) => restPut(`/${p}.json`, tokenPayload))
  );

  const persisted = restResults.some((r) => r.status === 'fulfilled' && r.value?.ok);

  if (!persisted) return json(502, { ok: false, error: 'token_persist_failed' }, origin);

  return json(200, {
    ok: true,
    link: telegramLink,
    createdAt,
    expiresAt,
    tenant: tenantId,
    tenantId,
    queueKey,
    queueId,
    queueNumber,
    persisted,
    source: resolved.source,
    note: 'Token persisted using REST fallback',
  }, origin);
};
