'use strict';

/*
  createTelegramLink.js — QueueJoy Tenant-Aware Telegram Link Generator
  Netlify Serverless Function

  Writes tokens to ALL THREE paths:
    telegramTokens/{token}                                    (global lookup)
    tenants/{tenantId}/integrations/telegram/tokens/{token}   (tenant integration path)
    tenants/{tenantId}/telegramTokens/{token}                 (tenant lookup)

  Includes full metadata: queueKey, queueId, queueNumber, counterId, counterName, slug, tenantId
  Tries firebase-admin first, falls back to RTDB REST PUT
*/

const { nanoid } = require('nanoid');
const fetch = globalThis.fetch || require('node-fetch');

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 24 * 60 * 60 * 1000);

/* -------- helpers -------- */

function makeHeaders(origin) {
  const CORS = process.env.ALLOWED_ORIGIN || origin || '*';
  return {
    'Access-Control-Allow-Origin': CORS,
    'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, payload, origin) {
  return { statusCode: status, headers: makeHeaders(origin), body: JSON.stringify(payload) };
}

function sanitize(v, max = 2000) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function parseBody(event) {
  if (!event || !event.body) return {};
  try {
    return event.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8'))
      : JSON.parse(event.body);
  } catch {
    return {};
  }
}

function pickTenantCandidate(event, body) {
  if (body && (body.tenantId || body.tenant || body.slug))
    return sanitize(body.tenantId || body.tenant || body.slug);
  if (event?.queryStringParameters?.slug)
    return sanitize(event.queryStringParameters.slug);
  if (event?.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitize(low['x-tenant']);
  }
  return '';
}

function isLikelyTenantId(v) {
  const s = sanitize(v);
  if (!s || s.includes('/') || s.length < 8) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

/* -------- firebase-admin init -------- */

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
    if (sa)
      admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    else admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err?.message || String(err) };
  }
}

/* -------- tenant resolution -------- */

async function resolveTenantIdWithAdmin(admin, candidate) {
  const db = admin.database();
  const c = sanitize(candidate);
  if (!c) return null;

  // Check slugs/{candidate}
  try {
    const sSnap = await db.ref(`slugs/${c}`).get().catch(() => null);
    if (sSnap?.exists?.()) {
      const val = sSnap.val();
      if (typeof val === 'string' && val.trim()) return { tenantId: val.trim(), source: 'slugs.value' };
      if (val && typeof val === 'object' && (val.tenantId || val.id))
        return { tenantId: String(val.tenantId || val.id), source: 'slugs.obj' };
    }
  } catch {}

  // Check tenants/{candidate}/meta
  try {
    const tSnap = await db.ref(`tenants/${c}/meta`).get().catch(() => null);
    if (tSnap?.exists?.()) return { tenantId: c, source: 'tenants.meta' };
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
    if (typeof slugRec === 'string' && slugRec.trim())
      return { tenantId: slugRec.trim(), source: 'slugs.value.rest' };
    if (typeof slugRec === 'object' && (slugRec.tenantId || slugRec.id))
      return { tenantId: String(slugRec.tenantId || slugRec.id), source: 'slugs.obj.rest' };
  }

  const metaRec = await getJson(`/tenants/${encodeURIComponent(c)}/meta.json`);
  if (metaRec) return { tenantId: c, source: 'tenants.meta.rest' };

  return null;
}

/* -------- token payload builders -------- */

function buildTokenRecord({ tenantId, queueKey, queueId, queueNumber, token, createdAt, expiresAt, counterId, counterName, slug, meta, userAgent, ip }) {
  return {
    token,
    tenantId,
    slug: slug || '',
    queueKey: queueKey || '',
    queueId: queueId || '',
    queueNumber: queueNumber || queueId || '',
    counterId: counterId || '',
    counterName: counterName || '',
    createdAt,
    expiresAt,
    used: false,
    usedAt: null,
    chatId: null,
    meta: meta || '',
    userAgent: userAgent || null,
    ip: ip || null,
  };
}

/* -------- main handler -------- */

exports.handler = async function (event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '*';

  if (event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: makeHeaders(origin), body: '' };
  }

  if (!event || event.httpMethod !== 'POST')
    return json(405, { ok: false, error: 'Only POST allowed' }, origin);

  const body = parseBody(event);

  const queueKey = sanitize(body.queueKey || '');
  const queueId = sanitize(body.queueId || body.queueKey || '');
  const queueNumber = sanitize(body.queueNumber || body.number || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const slug = sanitize(body.slug || '');
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : sanitize(body.meta || '');

  const tenantCandidate =
    sanitize(body.tenantId) ||
    sanitize(body.tenant) ||
    sanitize(body.slug) ||
    sanitize(pickTenantCandidate(event, body));

  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const userAgent = event?.headers?.['user-agent'] || event?.headers?.['User-Agent'] || null;
  const ip =
    event?.headers?.['x-forwarded-for'] ||
    event?.headers?.['X-Forwarded-For'] ||
    event?.headers?.['x-nf-client-connection-ip'] ||
    null;

  const botEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
  const botUsername = String(botEnv).replace(/^@/, '').trim() || 'QueueJoyBot';
  const telegramLink = `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;

  // Build the single consistent token payload used for ALL paths
  const tokenPayload = buildTokenRecord({
    tenantId: '', // will be set after resolution
    queueKey,
    queueId,
    queueNumber,
    token,
    createdAt,
    expiresAt,
    counterId,
    counterName,
    slug,
    meta,
    userAgent,
    ip,
  });

  const init = tryInitAdmin();

  /* ---------- Resolve tenant ---------- */
  let resolved = null;

  if (init.ok && init.admin) {
    if (tenantCandidate) resolved = await resolveTenantIdWithAdmin(init.admin, tenantCandidate);
    if (!resolved && body.tenantId && isLikelyTenantId(body.tenantId))
      resolved = { tenantId: sanitize(body.tenantId), source: 'body.tenantId' };
    if (!resolved && body.slug) resolved = await resolveTenantIdWithAdmin(init.admin, sanitize(body.slug));
  } else {
    const FIREBASE_DB_URL =
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_RTDB_URL ||
      '';
    if (FIREBASE_DB_URL) {
      if (tenantCandidate) resolved = await resolveTenantIdWithRest(FIREBASE_DB_URL, tenantCandidate);
      if (!resolved && body.tenantId && isLikelyTenantId(body.tenantId))
        resolved = { tenantId: sanitize(body.tenantId), source: 'body.tenantId.rest' };
      if (!resolved && body.slug) resolved = await resolveTenantIdWithRest(FIREBASE_DB_URL, body.slug);
    }
  }

  if (!resolved) {
    return json(400, {
      ok: false,
      error: 'tenant_not_resolved',
      note: 'Could not resolve tenant from provided slug or tenantId. Token not created.',
    }, origin);
  }

  const tenantId = resolved.tenantId;
  tokenPayload.tenantId = tenantId;

  const TOKEN_PATHS = [
    `telegramTokens/${token}`,
    `tenants/${tenantId}/integrations/telegram/tokens/${token}`,
    `tenants/${tenantId}/telegramTokens/${token}`,
  ];

  /* ---------- Admin write (atomic) ---------- */
  if (init.ok && init.admin) {
    try {
      const db = init.admin.database();
      const updates = {};
      for (const p of TOKEN_PATHS) {
        updates[p] = tokenPayload;
      }
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
        paths: TOKEN_PATHS,
      }, origin);
    } catch (err) {
      console.error('createTelegramLink: admin write failed, falling through to REST', err?.stack || err);
    }
  }

  /* ---------- REST fallback ---------- */
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
    TOKEN_PATHS.map((p) => restPut(`/${p}.json`, tokenPayload))
  );

  const persisted = restResults.some((r) => r.status === 'fulfilled' && r.value?.ok);

  return json(200, {
    ok: true,
    link: telegramLink,
    token,
    createdAt,
    expiresAt,
    tenant: tenantId,
    persisted,
    source: resolved.source,
    paths: TOKEN_PATHS,
    note: persisted ? 'Written via REST fallback to all paths' : 'REST writes may have failed',
  }, origin);
};
