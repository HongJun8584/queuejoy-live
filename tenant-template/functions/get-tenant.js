'use strict';

/**
 * get-tenant.js - robust Netlify function (tenant slug -> tenantId via /slugs)
 *
 * - CommonJS export (exports.handler) for Netlify lambdas
 * - Accepts slug via query ?slug=... or pathParameters or JSON body
 * - Admin access via x-master-key or ?master_key=... or x-admin-token / Authorization Bearer
 * - Returns sanitized public view for non-admin callers, full tenant for admin callers
 * - Safe fallback to TEST_PUBLIC_CONFIG / TEST_TENANT_SLUG when firebase-admin not configured
 * - In-memory cache with TTL (env GET_TENANT_CACHE_TTL_MS)
 * - Redacts secrets from configs returned to clients
 */

const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 1 minute

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key,x-admin-token',
  'Content-Type': 'application/json'
};

function jsonResp(code, body) {
  return { statusCode: code, headers: HEADERS, body: JSON.stringify(body) };
}

function safeClone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o || {}; }
}

function redactSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = safeClone(cfg);
  const secrets = ['serviceAccount', 'privateKey', 'private_key', 'client_email', 'adminKey', 'secret', 'apiKey', '_internal', 'credentials', 'service_account', 'password', 'token'];
  for (const k of secrets) if (k in clone) delete clone[k];
  return clone;
}

function buildSafePublic(tenantObj) {
  const safe = {};
  try {
    if (!tenantObj || typeof tenantObj !== 'object') return safe;
    if (tenantObj.public && typeof tenantObj.public === 'object') {
      Object.assign(safe, tenantObj.public);
      if (tenantObj.public.config && typeof tenantObj.public.config === 'object') {
        Object.assign(safe, tenantObj.public.config);
      }
    }
    if (!Object.keys(safe).length && tenantObj.settings && typeof tenantObj.settings === 'object') {
      Object.assign(safe, tenantObj.settings);
    }
    if (tenantObj.meta && typeof tenantObj.meta === 'object') {
      safe.name = safe.name || tenantObj.meta.name || tenantObj.meta.displayName || null;
      safe.slug = safe.slug || tenantObj.meta.slug || null;
      if (tenantObj.meta.plan) safe.plan = tenantObj.meta.plan;
      if (tenantObj.meta.branding) safe.branding = tenantObj.meta.branding;
    }
  } catch (e) {
    console.warn('buildSafePublic warning:', e && e.message);
  }
  return safe;
}

/* ---------- Firebase admin init helper (robust) ---------- */
async function ensureAdmin() {
  let admin = null;
  try {
    // prefer local helper if present, otherwise require firebase-admin
    const maybe = require('./lib/firebaseAdmin');
    if (maybe && typeof maybe === 'object' && maybe.database) admin = maybe;
    else if (maybe && typeof maybe === 'function') {
      try { admin = maybe(); } catch (err) { admin = maybe; }
    } else admin = null;
  } catch (e) {
    admin = null;
  }

  if (!admin) {
    try { admin = require('firebase-admin'); } catch (e) { throw new Error('firebase-admin module not available. Add firebase-admin dependency or provide ./lib/firebaseAdmin.'); }
  }

  if (admin.apps && admin.apps.length && admin.database) return admin;

  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || null;
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || null;
  const initOptions = {};
  if (dbUrl) initOptions.databaseURL = dbUrl;

  if (saRaw) {
    let saObj = null;
    try {
      if (/^[A-Za-z0-9+/=]+$/.test(saRaw) && saRaw.length % 4 === 0) {
        saObj = JSON.parse(Buffer.from(saRaw, 'base64').toString('utf8'));
      } else {
        saObj = JSON.parse(saRaw);
      }
    } catch (e) {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT* env value. Must be JSON or base64-encoded JSON.');
    }
    try {
      admin.initializeApp({ credential: admin.credential.cert(saObj), ...initOptions });
    } catch (e) {
      if (!(admin.apps && admin.apps.length)) throw e;
    }
  } else {
    try {
      admin.initializeApp({ ...initOptions });
    } catch (e) {
      if (!(admin.apps && admin.apps.length)) {
        throw new Error('Failed to initialize firebase-admin. Provide FIREBASE_SERVICE_ACCOUNT or set ADC in environment.');
      }
    }
  }

  return admin;
}

/* ---------- Caching ---------- */
const CACHE_TTL = (() => {
  const v = parseInt(process.env.GET_TENANT_CACHE_TTL_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CACHE_TTL_MS;
})();
const CACHE = new Map(); // slug -> { expiresAt, payload }

/* ---------- Helpers to parse incoming auth keys ---------- */
function parseIncomingKey(event) {
  const qs = event.queryStringParameters || {};
  return qs.master_key || qs.masterKey || (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) || null;
}

function parseAdminToken(event) {
  const h = event.headers || {};
  if (h['x-admin-token'] || h['X-Admin-Token']) return h['x-admin-token'] || h['X-Admin-Token'];
  if (h.authorization) {
    const m = String(h.authorization).trim().match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return null;
}

/* ---------- Slug mapping (RTDB / Firestore flexible) ---------- */
async function readSlugMapping(admin, slug) {
  const slugsPath = (process.env.SLUGS_PATH || process.env.SLUG_PATH || 'slugs').replace(/^\/+|\/+$/g, '');
  const rtdbPath = `${slugsPath}/${slug}`;
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(rtdbPath);
      let snap = null;
      if (typeof ref.get === 'function') snap = await ref.get().catch(()=>null);
      else if (typeof ref.once === 'function') snap = await ref.once('value').catch(()=>null);
      if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
        const val = typeof snap.val === 'function' ? snap.val() : snap;
        if (typeof val === 'string') return { tenantId: val, source: 'rtdb_value' };
        if (val && typeof val === 'object' && val.tenantId) return { tenantId: val.tenantId, source: 'rtdb_obj' };
      }
    }
  } catch (e) { /* ignore and fallthrough */ }

  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      const doc = await fs.collection(slugsPath).doc(slug).get().catch(()=>null);
      if (doc && doc.exists) {
        const data = doc.data();
        if (!data) return null;
        if (typeof data === 'string') return { tenantId: data, source: 'firestore_value' };
        if (data.tenantId) return { tenantId: data.tenantId, source: 'firestore_obj' };
        if (data.id && typeof data.id === 'string') return { tenantId: data.id, source: 'firestore_id' };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

/* ---------- Read public config (RTDB/Firestore tolerant) ---------- */
async function readTenantConfig(admin, tenantId) {
  const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
  const publicPath = `${basePath}/${tenantId}/public/config`;
  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      const docRef = fs.collection(basePath).doc(tenantId).collection('public').doc('config');
      const doc = await docRef.get().catch(()=>null);
      if (doc && doc.exists) return { config: doc.data(), source: 'firestore.public.config' };
      const tenantDoc = await fs.collection(basePath).doc(tenantId).get().catch(()=>null);
      if (tenantDoc && tenantDoc.exists) {
        const data = tenantDoc.data();
        if (data && data.public && typeof data.public === 'object') {
          if (data.public.config && typeof data.public.config === 'object') return { config: data.public.config, source: 'firestore.tenant.public.configField' };
          return { config: data.public, source: 'firestore.tenant.public' };
        }
      }
    }
  } catch (e) { /* ignore and fallback */ }

  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(publicPath);
      if (typeof ref.get === 'function') {
        const snap = await ref.get().catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config' };
      } else if (typeof ref.once === 'function') {
        const snap = await ref.once('value').catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config.once' };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

/* ---------- Handler ---------- */
exports.handler = async function (event, context) {
  try {
    // Accept slug from query, pathParameters, or JSON body
    let slug = null;
    const qs = event.queryStringParameters || {};
    slug = qs.slug || slug;
    if (!slug && event.pathParameters && event.pathParameters.slug) slug = event.pathParameters.slug;
    if (!slug && event.body) {
      try {
        const parsed = event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body);
        if (parsed && parsed.slug) slug = String(parsed.slug).trim();
      } catch (e) { /* ignore parse errors */ }
    }

    if (!slug) return jsonResp(400, { error: 'missing slug param' });

    // Cache fast-path
    const cached = CACHE.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonResp(200, { source: 'cache', config: safeClone(cached.payload) });
    }

    // Init firebase-admin (robust)
    const init = await (async () => {
      try {
        const a = await ensureAdmin();
        return { ok: true, admin: a };
      } catch (e) {
        return { ok: false, reason: e && e.message ? e.message : String(e) };
      }
    })();

    if (!init.ok || !init.admin) {
      // env fallback for local/demo mode
      const envDb = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || null;
      const TEST_TENANT_ID = process.env.TEST_TENANT_ID || null;
      const testPublic = (() => {
        const raw = process.env.TEST_PUBLIC_CONFIG_BASE64 || process.env.TEST_PUBLIC_CONFIG || null;
        if (!raw) return null;
        try {
          if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
          return JSON.parse(raw);
        } catch (e) { return null; }
      })();
      if (envDb) {
        const cfg = Object.assign({ databaseURL: envDb }, testPublic ? testPublic : {});
        const safeCfg = redactSecrets(cfg);
        CACHE.set(slug, { expiresAt: Date.now() + CACHE_TTL, payload: safeCfg });
        return jsonResp(200, { source: 'env.fallback', tenantId: TEST_TENANT_ID || null, config: safeClone(safeCfg) });
      }
      return jsonResp(500, { error: 'firebase_admin_unavailable', detail: init.reason || null });
    }

    const admin = init.admin;

    // 1) try to find tenantId from slugs mapping
    const mapping = await readSlugMapping(admin, slug);
    let tenantId = mapping && mapping.tenantId ? mapping.tenantId : null;
    const mapSource = mapping && mapping.source ? mapping.source : null;

    // 2) read tenant config (search by tenantId if found, else try slug as id)
    let configResult = null;
    if (tenantId) {
      configResult = await readTenantConfig(admin, tenantId);
    } else {
      configResult = await readTenantConfig(admin, slug);
      if (configResult) tenantId = slug;
    }

    if (!configResult || !configResult.config) {
      const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
      const slugsPath = (process.env.SLUGS_PATH || process.env.SLUG_PATH || 'slugs').replace(/^\/+|\/+$/g, '');
      const tried = {
        attemptedSlugLookup: { path: `${slugsPath}/${slug}`, foundTenantId: tenantId || null, mapSource },
        attemptedConfigPaths: [
          `${basePath}/${tenantId || slug}/public/config`,
          `${basePath}/${tenantId || slug}`
        ]
      };
      return jsonResp(404, { error: 'tenant not found', pathTried: tried });
    }

    // determine caller privileges
    const incomingKey = parseIncomingKey(event);
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    const adminToken = parseAdminToken(event);
    const isAdminCaller = (MASTER_KEY && incomingKey === MASTER_KEY) || (process.env.TEST_ADMIN_TOKEN && adminToken && adminToken === process.env.TEST_ADMIN_TOKEN);

    if (isAdminCaller) {
      // read full tenant object (admin only)
      try {
        const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
        const tenantRef = admin.database().ref(`${basePath}/${tenantId}`);
        const tenantSnap = await tenantRef.once('value');
        if (!tenantSnap || !tenantSnap.exists()) return jsonResp(404, { error: 'tenant_not_found', message: `no tenant node for id ${tenantId}` });
        const tenant = tenantSnap.val();
        return jsonResp(200, { tenantId, slug, tenant });
      } catch (e) {
        console.error('read full tenant failed:', e && (e.stack || e.message || e));
        return jsonResp(500, { error: 'read_tenant_failed' });
      }
    }

    // safe public path
    const safeCfg = redactSecrets(configResult.config);
    CACHE.set(slug, { expiresAt: Date.now() + CACHE_TTL, payload: safeCfg });
    return jsonResp(200, { source: configResult.source || 'unknown', tenantId: tenantId || null, config: safeClone(safeCfg) });

  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, { error: 'internal_error', message: err && err.message ? err.message : 'internal error' });
  }
};