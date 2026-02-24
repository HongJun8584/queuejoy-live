'use strict';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

const CACHE = {
  ttlMs: (() => {
    const v = parseInt(process.env.GET_CONFIG_CACHE_TTL_MS || '', 10);
    return Number.isFinite(v) && v > 0 ? v : 60 * 1000;
  })(),
  store: new Map()
};

function resp(code, body) {
  return { statusCode: code, headers, body: JSON.stringify(body) };
}

function safeClone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o || {}; }
}
function redactSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = safeClone(cfg);
  const secrets = ['serviceAccount', 'privateKey', 'private_key', 'client_email', 'adminKey', 'secret', 'apiKey', '_internal', 'credentials', 'service_account'];
  for (const k of secrets) if (k in clone) delete clone[k];
  return clone;
}

// try to init firebase-admin (same logic as your original helper)
function tryInitAdmin() {
  let admin = null;
  try { admin = require('firebase-admin'); } catch (e) {
    try { admin = require('./lib/firebaseAdmin'); } catch (e2) { admin = null; }
  }
  if (!admin) return { ok: false, reason: 'firebase-admin-not-installed' };
  if (admin.apps && admin.apps.length > 0) return { ok: true, admin };

  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;
  if (raw) {
    try { const maybe = Buffer.from(raw, 'base64').toString('utf8'); sa = JSON.parse(maybe); } catch (e) {
      try { sa = JSON.parse(raw); } catch (e2) { sa = null; }
    }
  }

  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || undefined;
  try {
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert(sa), ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    } else {
      admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', err: err && err.message ? err.message : String(err) };
  }
}

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
  } catch (e) { /* ignore */ }

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

function tryParseTestPublicConfig() {
  const raw = process.env.TEST_PUBLIC_CONFIG || process.env.TEST_PUBLIC_CONFIG_BASE64 || null;
  if (!raw) return null;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return JSON.parse(raw);
  } catch (e) { return null; }
}

exports.handler = async function (event) {
  try {
    let slug = null;
    if (event && event.queryStringParameters && event.queryStringParameters.slug) slug = String(event.queryStringParameters.slug).trim();
    else if (event && event.pathParameters && event.pathParameters.slug) slug = String(event.pathParameters.slug).trim();
    else if (event && event.body) {
      try {
        const parsed = event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body);
        if (parsed && parsed.slug) slug = String(parsed.slug).trim();
      } catch (e) {}
    }
    if (!slug) return resp(400, { error: 'missing slug' });

    // cache fast path
    const cached = CACHE.store.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return resp(200, { source: 'cache', config: safeClone(cached.payload) });
    }

    // init admin
    const init = tryInitAdmin();
    if (!init.ok || !init.admin) {
      // fallback to env-driven config when firebase-admin not available/initialized
      const envDb = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || null;
      const TEST_TENANT_ID = process.env.TEST_TENANT_ID || null;
      const testPublic = tryParseTestPublicConfig();
      if (envDb) {
        const cfg = Object.assign({ databaseURL: envDb }, testPublic ? testPublic : {});
        const safeCfg = redactSecrets(cfg);
        CACHE.store.set(slug, { expiresAt: Date.now() + CACHE.ttlMs, payload: safeCfg });
        return resp(200, { source: 'env.fallback', tenantId: TEST_TENANT_ID || null, config: safeClone(safeCfg) });
      }
      // otherwise return informative error
      return resp(500, { error: 'firebase_admin_unavailable', detail: init.reason || null });
    }

    const admin = init.admin;
    // 1) try to find tenantId from slugs mapping
    const mapping = await readSlugMapping(admin, slug);
    let tenantId = mapping && mapping.tenantId ? mapping.tenantId : null;
    const mapSource = mapping && mapping.source ? mapping.source : null;

    // 2) read tenant config
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
      return resp(404, { error: 'tenant not found', pathTried: tried });
    }

    const safeCfg = redactSecrets(configResult.config);
    CACHE.store.set(slug, { expiresAt: Date.now() + CACHE.ttlMs, payload: safeCfg });
    return resp(200, { source: configResult.source || 'unknown', tenantId: tenantId || null, config: safeClone(safeCfg) });

  } catch (err) {
    console.error('get-firebase-config: unexpected error', err && (err.stack || err));
    return resp(500, { error: 'internal_error', message: 'unexpected error' });
  }
};