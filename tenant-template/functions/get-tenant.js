// get-tenant.js - tenant-aware public endpoint (returns safe public config by default)
const admin = require('./lib/firebaseAdmin');

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
  const incomingKey = (qs.master_key || qs.masterKey || (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key']))) || null;
  return incomingKey;
}

function parseAdminToken(event) {
  const h = event.headers || {};
  return h['x-admin-token'] || h['X-Admin-Token'] || (h.authorization && h.authorization.replace(/^Bearer\s+/i, '')) || null;
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
  } catch (e) {
    return null;
  }
}

// Build a safe public view from the full tenant object
function buildSafePublic(tenantObj) {
  const safe = {};

  // prefer explicit public/config locations
  if (tenantObj.public && typeof tenantObj.public === 'object') {
    Object.assign(safe, tenantObj.public);
    if (tenantObj.public.config && typeof tenantObj.public.config === 'object') {
      Object.assign(safe, tenantObj.public.config);
    }
  }
  // fallback to settings or public config areas
  if (!Object.keys(safe).length && tenantObj.settings && typeof tenantObj.settings === 'object') {
    Object.assign(safe, tenantObj.settings);
  }
  // include some meta fields safely
  if (tenantObj.meta && typeof tenantObj.meta === 'object') {
    safe.name = safe.name || tenantObj.meta.name || tenantObj.meta.displayName || null;
    safe.slug = safe.slug || tenantObj.meta.slug || null;
    // include non-sensitive plan/branding, but don't leak billing/admin tokens
    if (tenantObj.meta.plan) safe.plan = tenantObj.meta.plan;
    if (tenantObj.meta.branding) safe.branding = tenantObj.meta.branding;
  }
  // ensure safe is always an object
  return safe;
}

exports.handler = async function(event, context) {
  try {
    const qs = event.queryStringParameters || {};
    const slug = qs.slug || (event.pathParameters && event.pathParameters.slug) || (event.body ? (() => {
      try { const p = event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body); return p.slug; } catch (e) { return null; }
    })() : null);

    if (!slug) return jsonResp(400, { error: 'missing slug param' });

    const incomingKey = parseIncomingKey(event);
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    const adminToken = parseAdminToken(event);
    const TEST_ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN || null;

    // If MASTER_KEY is configured, require it for admin-level access.
    // However we allow public callers if MASTER_KEY is not set.
    if (MASTER_KEY && incomingKey !== MASTER_KEY && incomingKey !== TEST_ADMIN_TOKEN) {
      // do not immediately block demo adminToken: allow TEST_ADMIN_TOKEN path later for demo fallback
      // return jsonResp(401, { error: 'invalid or missing master key' });
      // Instead allow the request to continue but treat it as non-admin (we'll return only public data).
    }

    // Detect whether firebase-admin is initialized
    const adminReady = !!(admin && admin.apps && admin.apps.length > 0 && admin.__initialized);

    // Demo fallback when admin not initialized: allow if TEST_SLUG matches or caller has TEST_ADMIN_TOKEN
    if (!adminReady) {
      const TEST_SLUG = process.env.TEST_TENANT_SLUG || null;
      const TEST_TENANT_ID = process.env.TEST_TENANT_ID || null;
      const allowDemo = (TEST_SLUG && TEST_SLUG === slug) || (adminToken && TEST_ADMIN_TOKEN && adminToken === TEST_ADMIN_TOKEN);

      if (allowDemo) {
        const demoPublic = tryParseTestPublicConfig() || { displayName: process.env.TEST_TENANT_DISPLAYNAME || 'Temp Tenant' };
        const demo = {
          tenantId: TEST_TENANT_ID || slug,
          slug,
          public: demoPublic,
          demo: true,
          message: 'returned demo tenant from environment (firebase admin not initialized)'
        };
        return jsonResp(200, demo);
      }

      return jsonResp(400, { error: 'firebase_not_configured', message: 'Firebase service account not set in environment. To run locally either set FIREBASE_SERVICE_ACCOUNT_* env or use TEST_TENANT_* variables.' });
    }

    // Normal path: admin SDK available - fetch tenant under tenants/{slug}
    const db = admin.database();
    const ref = db.ref(`tenants/${slug}`);
    const snap = await ref.once('value');
    const tenant = snap && snap.val ? snap.val() : null;
    if (!tenant) return jsonResp(404, { error: 'tenant not found' });

    // If caller provided valid MASTER_KEY or TEST_ADMIN_TOKEN, allow returning full tenant object (admin view)
    const isAdminCaller = (MASTER_KEY && incomingKey === MASTER_KEY) || (TEST_ADMIN_TOKEN && adminToken === TEST_ADMIN_TOKEN);

    if (isAdminCaller) {
      // return full tenant (admins expect full object)
      return jsonResp(200, { tenantId: slug, slug, tenant });
    }

    // Otherwise return only safe public view
    const safePublic = buildSafePublic(tenant);
    return jsonResp(200, { tenantId: slug, slug, public: safePublic });
  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, { error: err && err.message ? err.message : 'internal error' });
  }
};