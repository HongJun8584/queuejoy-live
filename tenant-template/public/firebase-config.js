'use strict';

/**
 * get-firebase-config.js
 * Netlify function: returns tenant-scoped firebase client config
 *
 * Query param: ?slug=your-tenant-slug
 *
 * Behavior:
 *  - Lookup slug -> tenantId via RTDB /slugs/{slug} (or Firestore if available)
 *  - Read tenants/{tenantId}/public/config
 *  - Prefer to return { firebaseClientConfig: <object> } (if found)
 *  - If not present, attempt to construct minimal client config from known keys
 *  - Cache results in-memory for a short TTL
 *
 * Required env ideally:
 *  - FIREBASE_DATABASE_URL (or FIREBASE_DB_URL) OR FIREBASE_SERVICE_ACCOUNT_BASE64
 *  - (optional) SLUGS_PATH (default 'slugs'), FIREBASE_PATH (default 'tenants')
 *  - (optional) GET_TENANT_CACHE_TTL_MS
 *
 * Fallback:
 *  - If admin unavailable but TEST_PUBLIC_CONFIG env is set (or base64), returns that config as env fallback.
 */

const CACHE = new Map();
const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 1 minute
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function jsonResp(code, body) {
  return { statusCode: code, headers: HEADERS, body: JSON.stringify(body) };
}

function safeParseMaybeBase64(raw) {
  if (!raw) return null;
  try {
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, '').length % 4 === 0) {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    }
  } catch (e) {}
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function ensureAdmin() {
  // Try to use local helper if present
  try {
    const local = require('./lib/firebaseAdmin');
    if (local && local.database) return local;
  } catch (e) { /* ignore */ }

  let admin;
  try { admin = require('firebase-admin'); } catch (e) { throw new Error('firebase-admin module not available'); }

  // If already initialized and db url matches, return
  try {
    if (admin.apps && admin.apps.length && admin.database) {
      return admin;
    }
  } catch (e) { /* continue init */ }

  // Parse service account or db url from env
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  const dbUrl = (process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '').trim() || null;

  const initOpts = {};
  if (dbUrl) initOpts.databaseURL = dbUrl;

  if (saRaw) {
    const saObj = safeParseMaybeBase64(saRaw);
    if (!saObj) throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT* env: must be JSON or base64 JSON');
    try {
      admin.initializeApp({ credential: admin.credential.cert(saObj), ...initOpts });
      return admin;
    } catch (err) {
      // If init fails but admin.apps exists, try to continue
      if (!(admin.apps && admin.apps.length)) throw err;
      return admin;
    }
  }

  // Try initialize with only databaseURL (ADC may be present in platform env)
  try {
    admin.initializeApp({ ...(initOpts) });
    return admin;
  } catch (err) {
    if (admin.apps && admin.apps.length) return admin;
    throw new Error('Failed to initialize firebase-admin. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or set FIREBASE_DATABASE_URL.');
  }
}

async function readSlugMapping(admin, slug) {
  const slugsPath = (process.env.SLUGS_PATH || 'slugs').replace(/^\/+|\/+$/g, '');
  // Try RTDB first
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(`${slugsPath}/${slug}`);
      if (typeof ref.get === 'function') {
        const snap = await ref.get().catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          const val = typeof snap.val === 'function' ? snap.val() : snap;
          if (typeof val === 'string') return { tenantId: val, source: 'rtdb_value' };
          if (val && typeof val === 'object' && val.tenantId) return { tenantId: val.tenantId, source: 'rtdb_obj' };
        }
      } else if (typeof ref.once === 'function') {
        const snap = await ref.once('value').catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          const val = typeof snap.val === 'function' ? snap.val() : snap;
          if (typeof val === 'string') return { tenantId: val, source: 'rtdb_value' };
          if (val && typeof val === 'object' && val.tenantId) return { tenantId: val.tenantId, source: 'rtdb_obj' };
        }
      }
    }
  } catch (e) { /* ignore */ }

  // Try Firestore mapping if available
  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      const doc = await fs.collection(slugsPath).doc(slug).get().catch(()=>null);
      if (doc && doc.exists) {
        const data = doc.data();
        if (!data) return null;
        if (typeof data === 'string') return { tenantId: data, source: 'firestore_value' };
        if (data.tenantId) return { tenantId: data.tenantId, source: 'firestore_obj' };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

async function readTenantPublicConfig(admin, tenantId) {
  const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
  // Try Firestore public.config if possible
  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      // Common layout: collection(tenants)/doc(tenantId)/public/config (doc)
      const docRef = fs.collection(basePath).doc(tenantId).collection('public').doc('config');
      const doc = await docRef.get().catch(()=>null);
      if (doc && doc.exists) return { config: doc.data(), source: 'firestore.public.config' };

      // Another possibility: tenant doc has public field
      const tenantDoc = await fs.collection(basePath).doc(tenantId).get().catch(()=>null);
      if (tenantDoc && tenantDoc.exists) {
        const data = tenantDoc.data();
        if (data && data.public && typeof data.public === 'object') {
          if (data.public.config && typeof data.public.config === 'object') return { config: data.public.config, source: 'firestore.tenant.public.configField' };
          return { config: data.public, source: 'firestore.tenant.public' };
        }
      }
    }
  } catch (e) { /* ignore and fallback to RTDB */ }

  // RTDB path: /tenants/{tenantId}/public/config
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(`${basePath}/${tenantId}/public/config`);
      if (typeof ref.get === 'function') {
        const snap = await ref.get().catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config' };
        }
      } else if (typeof ref.once === 'function') {
        const snap = await ref.once('value').catch(()=>null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config.once' };
        }
      }
      // fallback: maybe published directly under tenants/{tenantId}/public
      const ref2 = db.ref(`${basePath}/${tenantId}/public`);
      const snap2 = await (typeof ref2.get === 'function' ? ref2.get().catch(()=>null) : ref2.once('value').catch(()=>null));
      if (snap2 && (typeof snap2.exists === 'function' ? snap2.exists() : snap2.val() != null)) {
        const v = typeof snap2.val === 'function' ? snap2.val() : snap2;
        if (v && v.config && typeof v.config === 'object') return { config: v.config, source: 'rtdb.public.as_field' };
        return { config: v, source: 'rtdb.public' };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

function buildClientConfigFromPublic(cfg) {
  // cfg may contain a firebaseClientConfig directly, or pieces we can use
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.firebaseClientConfig && typeof cfg.firebaseClientConfig === 'object') return cfg.firebaseClientConfig;
  // sometimes stored as firebaseConfig
  if (cfg.firebaseConfig && typeof cfg.firebaseConfig === 'object') return cfg.firebaseConfig;

  // try to build a minimal config if projectId / databaseURL / apiKey present
  const candidate = {};
  if (cfg.apiKey) candidate.apiKey = cfg.apiKey;
  if (cfg.authDomain) candidate.authDomain = cfg.authDomain;
  if (cfg.databaseURL) candidate.databaseURL = cfg.databaseURL;
  if (cfg.projectId) candidate.projectId = cfg.projectId;
  if (cfg.storageBucket) candidate.storageBucket = cfg.storageBucket;
  if (cfg.messagingSenderId) candidate.messagingSenderId = cfg.messagingSenderId;
  if (cfg.appId) candidate.appId = cfg.appId;
  if (Object.keys(candidate).length >= 2) return candidate; // require at least two keys to be useful
  return null;
}

const CACHE_TTL_MS = (() => {
  const v = parseInt(process.env.GET_TENANT_CACHE_TTL_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CACHE_TTL_MS;
})();

exports.handler = async function(event) {
  try {
    const qs = event.queryStringParameters || {};
    const slug = (qs.slug || '').trim();
    if (!slug) return jsonResp(400, { error: 'missing slug' });

    // cache fast path
    const cached = CACHE.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonResp(200, { source: 'cache', firebaseClientConfig: cached.payload });
    }

    // try init admin
    let admin;
    try {
      admin = await ensureAdmin();
    } catch (e) {
      // admin not available -> try env fallback (TEST_PUBLIC_CONFIG / TEST_PUBLIC_CONFIG_BASE64)
      const raw = process.env.TEST_PUBLIC_CONFIG_BASE64 || process.env.TEST_PUBLIC_CONFIG || null;
      const parsed = safeParseMaybeBase64(raw);
      if (parsed) {
        const cfg = buildClientConfigFromPublic(parsed) || parsed;
        CACHE.set(slug, { expiresAt: Date.now() + CACHE_TTL_MS, payload: cfg });
        return jsonResp(200, { source: 'env.fallback', firebaseClientConfig: cfg });
      }
      return jsonResp(500, { error: 'firebase_admin_unavailable', message: String(e && e.message) });
    }

    // 1) try to resolve slug -> tenantId
    let tenantId = null;
    try {
      const mapping = await readSlugMapping(admin, slug);
      if (mapping && mapping.tenantId) tenantId = mapping.tenantId;
    } catch (e) { /* ignore resolution error and try slug as tenantId */ }

    // 2) read tenant public config
    let configResult = null;
    try {
      if (tenantId) configResult = await readTenantPublicConfig(admin, tenantId);
      if (!configResult) {
        // try slug as tenantId
        configResult = await readTenantPublicConfig(admin, slug);
        if (configResult && !tenantId) tenantId = slug;
      }
    } catch (e) {
      // log then continue to error out below
      console.warn('readTenantPublicConfig error', e && e.message);
    }

    if (!configResult || !configResult.config) {
      return jsonResp(404, { error: 'tenant_not_found', tried: { tenantId, slug } });
    }

    const publicCfg = configResult.config;
    // first prefer explicit firebaseClientConfig
    let clientCfg = buildClientConfigFromPublic(publicCfg);

    if (!clientCfg) {
      // maybe a nested firebaseClientConfig field
      if (publicCfg.firebaseClientConfig && typeof publicCfg.firebaseClientConfig === 'object') {
        clientCfg = publicCfg.firebaseClientConfig;
      } else if (publicCfg.firebaseConfig && typeof publicCfg.firebaseConfig === 'object') {
        clientCfg = publicCfg.firebaseConfig;
      }
    }

    if (!clientCfg) {
      // last effort: if we have global DB URL env and tenantId, try to build minimal client config that points to same RTDB
      const envDb = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || null;
      if (envDb) {
        clientCfg = { databaseURL: envDb };
      }
    }

    if (!clientCfg) {
      return jsonResp(404, { error: 'no_client_config', message: 'tenant public config found but no firebase client config present' });
    }

    // cache and return
    CACHE.set(slug, { expiresAt: Date.now() + CACHE_TTL_MS, payload: clientCfg });
    return jsonResp(200, { source: configResult.source || 'tenant.public.config', tenantId: tenantId || null, firebaseClientConfig: clientCfg });

  } catch (err) {
    console.error('get-firebase-config unexpected', err && (err.stack || err.message || err));
    return jsonResp(500, { error: 'internal_error', message: String(err && err.message) });
  }
};