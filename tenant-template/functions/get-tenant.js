'use strict';

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
  return qs.master_key || qs.masterKey || (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) || null;
}

function parseAdminToken(event) {
  const h = event.headers || {};
  return h['x-admin-token'] || h['X-Admin-Token'] || (h.authorization && h.authorization.replace(/^Bearer\s+/i, '')) || null;
}

// Build safe public view
function buildSafePublic(tenantObj) {
  const safe = {};
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
  return safe;
}

exports.handler = async function(event, context) {
  try {
    const qs = event.queryStringParameters || {};
    const slug = qs.slug;
    if (!slug) return jsonResp(400, { error: 'missing slug param' });

    const incomingKey = parseIncomingKey(event);
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    const adminToken = parseAdminToken(event);

    // require MASTER_KEY for admin-level access
    const isAdminCaller = (MASTER_KEY && incomingKey === MASTER_KEY);

    // ensure firebase admin initialized
    if (!admin.apps || !admin.apps.length) {
      admin.initializeApp({ databaseURL: process.env.FIREBASE_DATABASE_URL });
    }
    const db = admin.database();

    // lookup tenantId via /slugs/{slug}
    const slugSnap = await db.ref(`/slugs/${slug}`).once('value');
    if (!slugSnap.exists()) return jsonResp(404, { error: 'tenant not found' });

    const tenantId = slugSnap.val().tenantId;
    const tenantSnap = await db.ref(`/tenants/${tenantId}`).once('value');
    const tenant = tenantSnap.exists() ? tenantSnap.val() : null;
    if (!tenant) return jsonResp(404, { error: 'tenant not found' });

    if (isAdminCaller) {
      return jsonResp(200, { tenantId, slug, tenant });
    }

    const safePublic = buildSafePublic(tenant);
    return jsonResp(200, { tenantId, slug, public: safePublic });
  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return jsonResp(500, { error: err && err.message ? err.message : 'internal error' });
  }
};