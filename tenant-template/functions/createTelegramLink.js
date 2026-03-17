// createTelegramLink.js
'use strict';

/*
  createTelegramLink.js - Netlify function
  - Writes tokens to:
      tenants/{tenantId}/integrations/telegram/tokens/{token}
      telegramTokens/{token}
  - Tries firebase-admin first, falls back to RTDB REST PUT when admin unavailable
  - Env:
      FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT (JSON text)
      FIREBASE_DATABASE_URL (or FIREBASE_DB_URL / FIREBASE_RTDB_URL)
      BOT_USERNAME (optional, default QueueJoyBot)
      ALLOWED_ORIGIN (CORS)
*/

const { nanoid } = require('nanoid');

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 24 * 60 * 60 * 1000); // default 24h

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
  } catch (e) {
    return {};
  }
}

function pickTenantCandidate(event, body) {
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
      // try default application credentials (Netlify may not provide)
      admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', detail: err && err.message ? err.message : String(err) };
  }
}

/* -------- helpers to resolve slug -> tenantId (RTDB) using admin SDK -------- */
async function resolveTenantIdWithAdmin(admin, slugOrId) {
  const db = admin.database();
  // try slugs/{slug}
  try {
    const sRef = db.ref(`slugs/${slugOrId}`);
    const sSnap = await sRef.get().catch(()=>null);
    if (sSnap && sSnap.exists && sSnap.exists()) {
      const val = sSnap.val();
      if (typeof val === 'string' && val.trim()) return { tenantId: val.trim(), source: 'slugs.value' };
      if (val && typeof val === 'object' && (val.tenantId || val.id)) return { tenantId: String(val.tenantId || val.id), source: 'slugs.obj' };
    }
  } catch (e) {
    // ignore
  }

  // fallback: check tenants/{id}/meta exists (tolerant)
  try {
    const tRef = db.ref(`tenants/${slugOrId}/meta`);
    const tSnap = await tRef.get().catch(()=>null);
    if (tSnap && tSnap.exists && tSnap.exists()) return { tenantId: slugOrId, source: 'tenants.meta' };
  } catch (e) {
    // ignore
  }

  // last-resort: treat the input as tenant id (but caller may want explicit null)
  return null;
}

/* -------- main handler -------- */
exports.handler = async function (event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '*';

  // CORS preflight
  if (event && event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: makeHeaders(origin),
      body: ''
    };
  }

  if (!event || event.httpMethod !== 'POST') return json(405, { error: 'Only POST allowed' }, origin);

  const body = parseBody(event);
  const queueKey = sanitize(body.queueKey || body.token || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : sanitize(body.meta || '');

  if (!queueKey) {
    // We still allow creating tokens without a queueKey, but warn user
    // If you want to require queueKey, uncomment the next line:
    // return json(400, { ok:false, error:'missing_queueKey' }, origin);
  }

  const tenantCandidate = pickTenantCandidate(event, body); // slug or tenantId

  // token generation
  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;
  const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || event.headers['x-nf-client-connection-ip'])) || null;

  const payload = {
    token,
    queueKey,
    counterId,
    counterName,
    meta,
    createdAt,
    expiresAt,
    used: false,
    userAgent,
    ip
  };

  // build Telegram deep-link
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
      } else if (body.tenantId) {
        resolved = { tenantId: sanitize(body.tenantId), source: 'body.tenantId' };
      }

      if (!resolved) {
        // Persist global fallback path only (so bot can still find token) and return a warning
        const db = admin.database();
        const globalPath = `telegramTokens/${token}`;
        await db.ref(globalPath).set({ ...payload, tenant: null });
        return json(200, {
          ok: true,
          link: telegramLink,
          token,
          createdAt,
          expiresAt,
          tenant: null,
          persisted: true,
          note: 'tenant not resolved — written to global telegramTokens path only',
          paths: [globalPath],
        }, origin);
      }

      const tenantId = resolved.tenantId;
      const tpath = `tenants/${tenantId}/integrations/telegram/tokens/${token}`;
      const globalPath = `telegramTokens/${token}`;

      // write both tenant-scoped token and global mapping (helps bot)
      const db = admin.database();
      const updates = {};
      updates[`${tpath}`] = payload;
      updates[`${globalPath}`] = { tenant: tenantId, queueKey, token, createdAt, expiresAt };

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
        paths: [tpath, globalPath]
      }, origin);

    } catch (err) {
      // Admin write failed: log and fall through to REST fallback
      console.error('createTelegramLink: admin write failed', err && (err.stack || err));
    }
  } else {
    console.warn('createTelegramLink: admin SDK unavailable:', init && init.reason ? init.reason : '(no details)');
  }

  // REST fallback if admin was unavailable or failed
  const FIREBASE_DB_URL_RAW = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '';
  const FIREBASE_DB_URL = String(FIREBASE_DB_URL_RAW).replace(/\/$/, '');

  if (!FIREBASE_DB_URL) {
    return json(500, { ok: false, error: 'no_firebase_config', note: 'admin SDK unavailable and FIREBASE_DB_URL not set for REST fallback' }, origin);
  }

  // If tenantCandidate exists, attempt to write under tenants/{tenantCandidate}/integrations/telegram/tokens/{token}.json
  // Also write a global telegramTokens/{token}.json
  const tenantPathEncoded = tenantCandidate ? `/tenants/${encodeURIComponent(tenantCandidate)}/integrations/telegram/tokens/${encodeURIComponent(token)}.json` : null;
  const globalPath = `/telegramTokens/${encodeURIComponent(token)}.json`;

  // helper to do PUT (fetch is available in Netlify functions runtime)
  async function restPut(path, bodyObj) {
    const url = `${FIREBASE_DB_URL}${path}`;
    try {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
      const text = await res.text().catch(()=>null);
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // try tenant write first (if candidate provided)
  const restResults = {};
  if (tenantPathEncoded) {
    restResults.tenant = await restPut(tenantPathEncoded, payload);
  } else {
    restResults.tenant = { ok: false, status: 404, text: 'no tenantCandidate provided' };
  }

  // write global mapping too
  restResults.global = await restPut(globalPath, { tenant: tenantCandidate || null, queueKey, token, createdAt, expiresAt });

  // Interpret results
  const persisted = (restResults.tenant && restResults.tenant.ok) || (restResults.global && restResults.global.ok);

  return json(200, {
    ok: true,
    link: telegramLink,
    token,
    createdAt,
    expiresAt,
    tenant: tenantCandidate || null,
    persisted,
    restResults,
    note: persisted ? 'written via REST fallback' : 'REST write attempted but may have failed (see restResults)'
  }, origin);
};