'use strict';

/**
 * get-tenant.js
 *
 * RTDB-only, tenant slug -> tenantId resolver.
 * Public settings are read ONLY from:
 *   tenants/{tenantId}/public/config
 *
 * Response shape for normal callers:
 *   { tenantId, slug, source, config }
 *
 * Response shape for admin callers:
 *   { tenantId, slug, tenant }
 */

const DEFAULT_CACHE_TTL_MS = 60 * 1000;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key,x-admin-token',
  'Content-Type': 'application/json'
};

function jsonResp(statusCode, body) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(body)
  };
}

function trimString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function safeClone(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v || {};
  }
}

function redactSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = safeClone(cfg);
  const secretKeys = [
    'serviceAccount',
    'privateKey',
    'private_key',
    'client_email',
    'adminKey',
    'secret',
    'apiKey',
    '_internal',
    'credentials',
    'service_account',
    'password',
    'token'
  ];
  for (const key of secretKeys) {
    if (key in clone) delete clone[key];
  }
  return clone;
}

function paths() {
  return {
    basePath: (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, ''),
    slugsPath: (process.env.SLUGS_PATH || process.env.SLUG_PATH || 'slugs').replace(/^\/+|\/+$/g, '')
  };
}

const CACHE_TTL = (() => {
  const n = parseInt(process.env.GET_TENANT_CACHE_TTL_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
})();
const CACHE = new Map(); // slug -> { expiresAt, payload }

function parseSlug(event) {
  const qs = event.queryStringParameters || {};
  let slug =
    trimString(qs.slug) ||
    trimString(qs.tenantSlug) ||
    trimString(qs.tenant);

  if (!slug && event.pathParameters && event.pathParameters.slug) {
    slug = trimString(event.pathParameters.slug);
  }

  if (!slug && event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      const parsed = JSON.parse(raw);
      slug = trimString(parsed.slug);
    } catch {
      // ignore
    }
  }

  return slug;
}

function parseIncomingKey(event) {
  const qs = event.queryStringParameters || {};
  return (
    trimString(qs.master_key) ||
    trimString(qs.masterKey) ||
    trimString(event.headers?.['x-master-key']) ||
    trimString(event.headers?.['X-Master-Key']) ||
    ''
  );
}

function parseAdminToken(event) {
  const h = event.headers || {};
  const direct =
    trimString(h['x-admin-token']) ||
    trimString(h['X-Admin-Token']);
  if (direct) return direct;

  const auth = trimString(h.authorization || h.Authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? trimString(m[1]) : '';
}

async function ensureAdmin() {
  let admin;

  try {
    const maybe = require('./lib/firebaseAdmin');
    if (maybe && typeof maybe === 'object' && typeof maybe.database === 'function') {
      admin = maybe;
    } else if (typeof maybe === 'function') {
      admin = await maybe();
    }
  } catch {
    // ignore
  }

  if (!admin) {
    try {
      admin = require('firebase-admin');
    } catch {
      throw new Error('firebase-admin module not available');
    }
  }

  if (admin.apps && admin.apps.length) return admin;

  const dbUrl =
    process.env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DB_URL ||
    '';

  const saRaw =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    '';

  const initOptions = {};
  if (dbUrl) initOptions.databaseURL = dbUrl;

  if (saRaw) {
    let saObj;
    try {
      if (/^[A-Za-z0-9+/=]+$/.test(saRaw) && saRaw.length % 4 === 0) {
        saObj = JSON.parse(Buffer.from(saRaw, 'base64').toString('utf8'));
      } else {
        saObj = JSON.parse(saRaw);
      }
    } catch {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT* value');
    }

    admin.initializeApp({
      credential: admin.credential.cert(saObj),
      ...initOptions
    });
  } else {
    admin.initializeApp(initOptions);
  }

  return admin;
}

async function readJsonAtRef(ref) {
  const snap = typeof ref.get === 'function'
    ? await ref.get().catch(() => null)
    : await ref.once('value').catch(() => null);

  if (!snap) return null;
  const exists = typeof snap.exists === 'function' ? snap.exists() : snap.val() != null;
  if (!exists) return null;

  return typeof snap.val === 'function' ? snap.val() : snap;
}

async function resolveTenantIdFromSlug(admin, slug) {
  const { basePath, slugsPath } = paths();

  // 1) preferred path: slugs/{slug} -> tenantId
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const mapSnap = await readJsonAtRef(db.ref(`${slugsPath}/${slug}`));

      if (mapSnap) {
        if (typeof mapSnap === 'string') {
          const tenantId = trimString(mapSnap);
          if (tenantId) return { tenantId, source: 'rtdb.slug.string' };
        }

        if (typeof mapSnap === 'object') {
          const tenantId = trimString(
            mapSnap.tenantId ||
            mapSnap.tenant ||
            mapSnap.id ||
            mapSnap.tenant_id ||
            ''
          );
          if (tenantId) return { tenantId, source: 'rtdb.slug.object' };
        }
      }
    }
  } catch {
    // ignore
  }

  // 2) fallback: slug is already the tenantId
  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const directConfig = await readJsonAtRef(db.ref(`${basePath}/${slug}/public/config`));
      if (directConfig) return { tenantId: slug, source: 'rtdb.direct-tenant' };
    }
  } catch {
    // ignore
  }

  return { tenantId: null, source: null };
}

async function readPublicConfig(admin, tenantId) {
  const { basePath } = paths();

  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const cfg = await readJsonAtRef(db.ref(`${basePath}/${tenantId}/public/config`));
      if (cfg) return { config: cfg, source: 'rtdb.public.config' };
    }
  } catch {
    // ignore
  }

  return null;
}

async function readFullTenant(admin, tenantId) {
  const { basePath } = paths();

  try {
    if (typeof admin.database === 'function') {
      const db = admin.database();
      const tenant = await readJsonAtRef(db.ref(`${basePath}/${tenantId}`));
      if (tenant) return tenant;
    }
  } catch {
    // ignore
  }

  return null;
}

exports.handler = async function (event) {
  try {
    const slug = parseSlug(event);
    if (!slug) {
      return jsonResp(400, { error: 'missing_slug' });
    }

    const cached = CACHE.get(slug);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonResp(200, safeClone(cached.payload));
    }

    const admin = await ensureAdmin();

    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || '';
    const TEST_ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN || '';
    const incomingKey = parseIncomingKey(event);
    const adminToken = parseAdminToken(event);
    const isAdminCaller =
      (MASTER_KEY && incomingKey && incomingKey === MASTER_KEY) ||
      (TEST_ADMIN_TOKEN && adminToken && adminToken === TEST_ADMIN_TOKEN);

    const resolved = await resolveTenantIdFromSlug(admin, slug);
    if (!resolved.tenantId) {
      const { basePath, slugsPath } = paths();
      return jsonResp(404, {
        error: 'tenant_not_found',
        message: 'Could not resolve tenantId from slug',
        slug,
        pathTried: {
          slugMapping: `${slugsPath}/${slug}`,
          directConfig: `${basePath}/${slug}/public/config`
        }
      });
    }

    if (isAdminCaller) {
      const tenant = await readFullTenant(admin, resolved.tenantId);
      if (!tenant) {
        return jsonResp(404, {
          error: 'tenant_not_found',
          message: `No tenant node found for ${resolved.tenantId}`,
          tenantId: resolved.tenantId,
          slug
        });
      }

      const payload = {
        tenantId: resolved.tenantId,
        slug,
        tenant
      };

      return jsonResp(200, payload);
    }

    const cfgResult = await readPublicConfig(admin, resolved.tenantId);
    if (!cfgResult || !cfgResult.config) {
      const { basePath } = paths();
      return jsonResp(404, {
        error: 'config_not_found',
        message: 'Public config not found at tenants/{tenantId}/public/config',
        tenantId: resolved.tenantId,
        slug,
        pathTried: `${basePath}/${resolved.tenantId}/public/config`
      });
    }

    const payload = {
      tenantId: resolved.tenantId,
      slug,
      source: cfgResult.source || resolved.source || 'unknown',
      config: redactSecrets(safeClone(cfgResult.config))
    };

    CACHE.set(slug, {
      expiresAt: Date.now() + CACHE_TTL,
      payload
    });

    return jsonResp(200, payload);
  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, {
      error: 'internal_error',
      message: err && err.message ? err.message : 'internal error'
    });
  }
};