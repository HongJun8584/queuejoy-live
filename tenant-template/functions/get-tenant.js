'use strict';

/**
 * get-tenant.js - robust Netlify function (tenant slug -> tenantId via /slugs)
 *
 * Returns safe public view for non-admin callers and full tenant for admin callers.
 */

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key,x-admin-token',
  'Content-Type': 'application/json'
};

function jsonResp(code, body) {
  return { statusCode: code, headers, body: JSON.stringify(body) };
}

function parseIncomingKey(event) {
  const qs = event.queryStringParameters || {};
  return qs.master_key || qs.masterKey || (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) || null;
}

function parseAdminToken(event) {
  const h = event.headers || {};
  return h['x-admin-token'] || h['X-Admin-Token'] || (h.authorization && h.authorization.replace(/^Bearer\s+/i, '')) || null;
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
    const maybe = require('./lib/firebaseAdmin');
    if (maybe && typeof maybe === 'object' && maybe.database) {
      admin = maybe;
    } else if (maybe && typeof maybe === 'function') {
      try { admin = maybe(); } catch (err) { admin = maybe; }
    } else {
      admin = null;
    }
  } catch (e) {
    admin = null;
  }

  if (!admin) {
    try {
      admin = require('firebase-admin');
    } catch (e) {
      throw new Error('firebase-admin module not available. Add firebase-admin dependency or provide ./lib/firebaseAdmin.');
    }
  }

  if (admin.apps && admin.apps.length && admin.database) {
    return admin;
  }

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

/* ---------- Handler ---------- */
exports.handler = async function(event, context) {
  try {
    const qs = event.queryStringParameters || {};
    const slug = qs.slug || (event.pathParameters && event.pathParameters.slug) || null;
    if (!slug) return jsonResp(400, { error: 'missing slug param' });

    const incomingKey = parseIncomingKey(event);
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    const adminToken = parseAdminToken(event);
    const isAdminCaller = (MASTER_KEY && incomingKey === MASTER_KEY) || (process.env.TEST_ADMIN_TOKEN && adminToken && adminToken === process.env.TEST_ADMIN_TOKEN);

    let admin;
    try {
      admin = await ensureAdmin();
    } catch (e) {
      console.error('firebase init failed:', e && e.message);
      const TEST_SLUG = process.env.TEST_TENANT_SLUG || null;
      if (TEST_SLUG && TEST_SLUG === slug) {
        const demoPublic = (() => {
          try {
            const raw = process.env.TEST_PUBLIC_CONFIG_BASE64 || process.env.TEST_PUBLIC_CONFIG || null;
            if (!raw) return { displayName: process.env.TEST_TENANT_DISPLAYNAME || 'Temp Tenant' };
            if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
              return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
            }
            return JSON.parse(raw);
          } catch (err) {
            return { displayName: process.env.TEST_TENANT_DISPLAYNAME || 'Temp Tenant' };
          }
        })();
        return jsonResp(200, { tenantId: slug, slug, public: demoPublic, demo: true, message: 'demo fallback (firebase not configured)' });
      }
      return jsonResp(500, { error: 'firebase_not_configured', message: e && e.message ? e.message : 'firebase initialization failed' });
    }

    const db = admin.database();
    const slugRef = db.ref(`/slugs/${slug}`);
    const slugSnap = await slugRef.once('value');
    if (!slugSnap.exists()) {
      return jsonResp(404, { error: 'tenant_not_found', message: `no slug record for ${slug}` });
    }
    const slugVal = slugSnap.val() || {};
    const tenantId = slugVal.tenantId || slugVal.id || slug;

    if (!tenantId) {
      return jsonResp(500, { error: 'no_tenant_id', message: 'slug record did not contain tenantId' });
    }

    const tenantRef = db.ref(`/tenants/${tenantId}`);
    const tenantSnap = await tenantRef.once('value');
    if (!tenantSnap.exists()) {
      return jsonResp(404, { error: 'tenant_not_found', message: `no tenant node for id ${tenantId}` });
    }
    const tenant = tenantSnap.val();

    if (isAdminCaller) {
      return jsonResp(200, { tenantId, slug, tenant });
    }

    const safePublic = buildSafePublic(tenant);
    return jsonResp(200, { tenantId, slug, public: safePublic });

  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, { error: 'internal_error', message: err && err.message ? err.message : 'internal error' });
  }
};
