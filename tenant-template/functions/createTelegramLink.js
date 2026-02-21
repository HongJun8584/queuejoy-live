'use strict';

/*
  createTelegramLink.js - production-grade Netlify function for QueueJoy
  - 使用 firebase-admin 优先写入 Realtime Database（不受 RTDB rules 限制）
  - 支持 slug 或 tenantId（优先解析 /slugs/{slug} -> tenantId）
  - 若 admin SDK 不可用，则回退到 REST 写入（并在响应里报告失败原因）
  - 环境变量：
      FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT (JSON text)
      FIREBASE_DATABASE_URL (或 FIREBASE_DB_URL / FIREBASE_RTDB_URL)
      BOT_USERNAME (可选, default QueueJoyBot)
      ALLOWED_ORIGIN (CORS, default '*')
*/

const { nanoid } = require('nanoid');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function sanitize(v, max = 1000) {
  if (v === undefined || v === null) return '';
  const s = (typeof v === 'string') ? v.trim() : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function parseBody(event) {
  if (!event || !event.body) return {};
  try {
    return event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body);
  } catch (e) {
    return {};
  }
}

function pickTenantFromReq(event, body) {
  // priority: body.tenantId | body.tenant | body.slug | query ?slug= | header x-tenant
  if (body && (body.tenantId || body.tenant || body.slug)) return sanitize(body.tenantId || body.tenant || body.slug);
  if (event && event.queryStringParameters && event.queryStringParameters.slug) return sanitize(event.queryStringParameters.slug);
  if (event && event.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitize(low['x-tenant']);
  }
  return '';
}

/* -------- firebase-admin init helper -------- */
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
    // try base64 decode then parse, otherwise raw json parse
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
      // try default app credentials
      admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err && err.message ? err.message : String(err) };
  }
}

/* -------- helpers to resolve slug -> tenantId (RTDB) -------- */
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
  } catch (e) {
    // ignore and continue
  }

  // if not found, verify slugOrId is a tenantId (tenants/{id}/public/config)
  try {
    const tRef = db.ref(`tenants/${slugOrId}/public/config`);
    const tSnap = await tRef.get().catch(()=>null);
    if (tSnap && tSnap.exists && tSnap.exists()) return { tenantId: slugOrId, source: 'direct-check' };
  } catch (e) {
    // ignore
  }

  return null;
}

/* -------- main handler -------- */
exports.handler = async function (event) {
  const CORS_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

  // handle preflight
  if (event && event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: makeHeaders(CORS_ORIGIN),
      body: ''
    };
  }

  if (!event || event.httpMethod !== 'POST') return json(405, { error: 'Only POST allowed' }, CORS_ORIGIN);

  const body = parseBody(event);
  const queueKey = sanitize(body.queueKey || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : sanitize(body.meta || '');

  const tenantCandidate = pickTenantFromReq(event, body); // slug or tenantId

  // generate token
  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;
  const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || event.headers['x-nf-client-connection-ip'])) || null;

  const payload = { queueKey, counterId, counterName, meta, createdAt, expiresAt, used: false, userAgent, ip };

  // build Telegram deep-link
  const botEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
  const botUsername = String(botEnv).replace(/^@/, '').trim() || 'QueueJoyBot';
  const telegramLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;

  // try admin SDK
  const init = tryInitAdmin();
  if (init.ok && init.admin) {
    try {
      const admin = init.admin;
      let resolved = null;
      if (tenantCandidate) {
        resolved = await resolveTenantIdWithAdmin(admin, tenantCandidate);
      } else if (body.tenantId) {
        resolved = { tenantId: sanitize(body.tenantId), source: 'body.tenantId' };
      }

      if (!resolved) {
        // don't fail hard: return link but mention token NOT persisted
        return json(200, { ok: true, link: telegramLink, token, createdAt, expiresAt, tenant: null, persisted: false, note: 'tenant not resolved; token not persisted' }, CORS_ORIGIN);
      }

      const tenantId = resolved.tenantId;
      const db = admin.database();
      await db.ref(`tenants/${tenantId}/telegramTokens/${token}`).set(payload);

      return json(200, { ok: true, link: telegramLink, token, createdAt, expiresAt, tenant: tenantId, persisted: true, source: resolved.source }, CORS_ORIGIN);
    } catch (err) {
      console.error('createTelegramLink: admin write failed', err && (err.stack || err));
      // fall through to REST fallback (which may be rejected by rules)
    }
  } else {
    console.warn('createTelegramLink: admin SDK unavailable:', init && init.reason ? init.reason : '(no details)');
  }

  // REST fallback (may be rejected by DB rules)
  const FIREBASE_DB_URL_RAW = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '';
  const FIREBASE_DB_URL = String(FIREBASE_DB_URL_RAW).replace(/\/$/, '');
  if (!FIREBASE_DB_URL) {
    return json(500, { ok: false, error: 'no_firebase_config', note: 'admin SDK unavailable and FIREBASE_DB_URL not set for REST fallback' }, CORS_ORIGIN);
  }

  // choose REST path
  const rTenant = tenantCandidate || '';
  const restPath = rTenant ? `${FIREBASE_DB_URL}/tenants/${encodeURIComponent(rTenant)}/telegramTokens/${encodeURIComponent(token)}.json`
                          : `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(token)}.json`;

  try {
    const resp = await fetch(restPath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await resp.text().catch(()=>'');
    if (!resp.ok) {
      console.warn('createTelegramLink: REST write failed', resp.status, text);
      return json(200, { ok: true, link: telegramLink, token, createdAt, expiresAt, tenant: null, persisted: false, restError: { status: resp.status, text } }, CORS_ORIGIN);
    }
    return json(200, { ok: true, link: telegramLink, token, createdAt, expiresAt, tenant: rTenant || null, persisted: true, method: 'rest' }, CORS_ORIGIN);
  } catch (err) {
    console.warn('createTelegramLink: REST write exception', String(err));
    return json(200, { ok: true, link: telegramLink, token, createdAt, expiresAt, tenant: null, persisted: false, restException: String(err) }, CORS_ORIGIN);
  }
};
