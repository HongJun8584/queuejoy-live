'use strict';

/*
  get-firebase-config.js
  - 安全稳健的 Netlify function
  - 输入：query param ?slug=...
  - 步骤：
    1) 尝试从缓存返回
    2) 初始化 firebase-admin (支持 BASE64 或 原始 JSON 环境变量)
    3) 在 /slugs/{slug} 查找 tenantId（支持 RTDB 与 Firestore）
    4) 读取 /tenants/{tenantId}/public/config（RTDB 或 Firestore）
    5) 返回脱敏后的 config
*/

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

// simple in-process cache
const CACHE = {
  ttlMs: (() => {
    const v = parseInt(process.env.GET_CONFIG_CACHE_TTL_MS || '', 10);
    return Number.isFinite(v) && v > 0 ? v : 60 * 1000;
  })(),
  store: new Map() // slug -> { expiresAt, payload }
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
  // keys to remove if present
  const secrets = ['serviceAccount', 'privateKey', 'private_key', 'client_email', 'adminKey', 'secret', 'apiKey', '_internal', 'credentials', 'service_account'];
  for (const k of secrets) {
    if (k in clone) delete clone[k];
  }
  return clone;
}

// try to initialize firebase-admin
function tryInitAdmin() {
  let admin = null;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    try {
      admin = require('./lib/firebaseAdmin'); // project helper fallback
    } catch (_e) {
      admin = null;
    }
  }

  if (!admin) return { ok: false, reason: 'firebase-admin-not-installed' };

  if (admin.apps && admin.apps.length > 0) {
    return { ok: true, admin };
  }

  // load service account from env
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  let sa = null;

  if (raw) {
    // try base64 decode first, then json parse; fallback to raw JSON
    try {
      const maybe = Buffer.from(raw, 'base64').toString('utf8');
      sa = JSON.parse(maybe);
    } catch (e) {
      try {
        sa = JSON.parse(raw);
      } catch (e2) {
        sa = null;
      }
    }
  }

  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || undefined;

  try {
    if (sa) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        ...(dbUrl ? { databaseURL: dbUrl } : {})
      });
    } else {
      // try app default creds (e.g. GOOGLE_APPLICATION_CREDENTIALS in env)
      admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    }
    return { ok: true, admin };
  } catch (err) {
    return { ok: false, reason: 'init_failed', err: err && err.message ? err.message : String(err) };
  }
}

async function readSlugMapping(admin, slug, opts) {
  // tries RTDB then Firestore; returns string tenantId or null
  const slugsPath = (process.env.SLUGS_PATH || process.env.SLUG_PATH || 'slugs').replace(/^\/+|\/+$/g, '');
  const rtdbPath = `${slugsPath}/${slug}`;

  // RTDB
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(rtdbPath);
      // support modern get() or once('value')
      let snap = null;
      if (typeof ref.get === 'function') {
        snap = await ref.get().catch(() => null);
        if (snap && snap.exists && snap.exists()) {
          const val = snap.val();
          if (typeof val === 'string') return { tenantId: val, source: 'rtdb_value' };
          if (val && typeof val === 'object' && val.tenantId) return { tenantId: val.tenantId, source: 'rtdb_obj' };
        }
      } else if (typeof ref.once === 'function') {
        snap = await ref.once('value').catch(() => null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          const val = snap.val();
          if (typeof val === 'string') return { tenantId: val, source: 'rtdb_value' };
          if (val && typeof val === 'object' && val.tenantId) return { tenantId: val.tenantId, source: 'rtdb_obj' };
        }
      }
    }
  } catch (e) {
    // ignore rtdb errors here
  }

  // Firestore
  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      const doc = await fs.collection(slugsPath).doc(slug).get().catch(() => null);
      if (doc && doc.exists) {
        const data = doc.data();
        if (!data) return null;
        if (typeof data === 'string') return { tenantId: data, source: 'firestore_value' };
        if (data.tenantId) return { tenantId: data.tenantId, source: 'firestore_obj' };
        // if doc has a field 'id' or 'value' try fallback
        if (data.id && typeof data.id === 'string') return { tenantId: data.id, source: 'firestore_id' };
      }
    }
  } catch (e) {
    // ignore
  }

  return null;
}

async function readTenantConfig(admin, tenantId) {
  const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
  const publicPath = `${basePath}/${tenantId}/public/config`;

  // Try Firestore: tenants collection -> doc(tenantId) -> subcollection public -> doc config OR field public
  try {
    if (typeof admin.firestore === 'function') {
      const fs = admin.firestore();
      // try doc: tenants/{tenantId}/public/config (as nested collection+doc)
      const docRef = fs.collection(basePath).doc(tenantId).collection('public').doc('config');
      const doc = await docRef.get().catch(() => null);
      if (doc && doc.exists) {
        return { config: doc.data(), source: 'firestore.public.config' };
      }
      // try field: tenants/{tenantId} doc has field 'public'
      const tenantDoc = await fs.collection(basePath).doc(tenantId).get().catch(() => null);
      if (tenantDoc && tenantDoc.exists) {
        const data = tenantDoc.data();
        if (data && data.public && typeof data.public === 'object') {
          // either the config is in public.config or public itself is config
          if (data.public.config && typeof data.public.config === 'object') return { config: data.public.config, source: 'firestore.tenant.public.configField' };
          return { config: data.public, source: 'firestore.tenant.public' };
        }
      }
    }
  } catch (e) {
    // ignore and fallback to RTDB
  }

  // RTDB fallback
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const ref = db.ref(publicPath);
      if (typeof ref.get === 'function') {
        const snap = await ref.get().catch(() => null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config' };
        }
      } else if (typeof ref.once === 'function') {
        const snap = await ref.once('value').catch(() => null);
        if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
          return { config: typeof snap.val === 'function' ? snap.val() : snap, source: 'rtdb.public.config.once' };
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return null;
}

exports.handler = async function (event) {
  try {
    // parse slug
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
      return resp(500, { error: 'firebase_admin_unavailable', detail: init.reason || null });
    }
    const admin = init.admin;

    // 1) try to find tenantId from slugs mapping
    const mapping = await readSlugMapping(admin, slug);
    let tenantId = mapping && mapping.tenantId ? mapping.tenantId : null;
    const mapSource = mapping && mapping.source ? mapping.source : null;

    // 2) if not found, maybe slug is already the tenantId (allow this)
    let configResult = null;
    if (tenantId) {
      configResult = await readTenantConfig(admin, tenantId);
    } else {
      // try using slug directly as tenantId
      configResult = await readTenantConfig(admin, slug);
      if (configResult) {
        tenantId = slug;
      } else {
        // If we still have mapping info but no config, attempt both paths tried for debug
        // For clarity, if mapping is null -> return 404 with pathTried
      }
    }

    if (!configResult || !configResult.config) {
      // Prepare helpful debug paths
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

    // sanitize and cache & return
    const safeCfg = redactSecrets(configResult.config);
    CACHE.store.set(slug, { expiresAt: Date.now() + CACHE.ttlMs, payload: safeCfg });

    return resp(200, { source: configResult.source || 'unknown', tenantId: tenantId || null, config: safeClone(safeCfg) });
  } catch (err) {
    console.error('get-firebase-config: unexpected error', err && (err.stack || err));
    return resp(500, { error: 'internal_error', message: 'unexpected error' });
  }
};