// get-tenant.js
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
  // 支持 x-admin-token 头和 Authorization: Bearer <token>
  const h = event.headers || {};
  return h['x-admin-token'] || h['X-Admin-Token'] || (h.authorization && h.authorization.replace(/^Bearer\s+/i, '')) || null;
}

function tryParseTestPublicConfig() {
  const raw = process.env.TEST_PUBLIC_CONFIG || process.env.TEST_PUBLIC_CONFIG_BASE64 || null;
  if (!raw) return null;
  try {
    // base64 decode if looks like base64
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
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

    // If MASTER_KEY is set, require it OR allow TEST_ADMIN_TOKEN as alternate for dev
    if (MASTER_KEY && incomingKey !== MASTER_KEY && incomingKey !== TEST_ADMIN_TOKEN) {
      return jsonResp(401, { error: 'invalid or missing master key' });
    }

    // If firebase admin is not initialized, support a demo fallback if TEST_TENANT_* present
    if (!admin.__initialized) {
      // allow if slug matches TEST_TENANT_SLUG OR caller presents TEST_ADMIN_TOKEN
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

      // explicit, clear error for dev debugging (non-crashing)
      return jsonResp(400, { error: 'firebase_not_configured', message: 'Firebase service account not set in environment. To run locally either set FIREBASE_SERVICE_ACCOUNT_* env or use TEST_TENANT_* variables.' });
    }

    // Normal path: firebase-admin is available and configured
    const db = admin.database();
    const ref = db.ref(`/tenants/${slug}`);
    const snap = await ref.once('value');
    const tenant = snap.val();
    if (!tenant) return jsonResp(404, { error: 'tenant not found' });

    return jsonResp(200, tenant);
  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, { error: err && err.message ? err.message : 'internal error' });
  }
};