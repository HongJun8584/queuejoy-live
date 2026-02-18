// tenant-template/functions/createBusiness.js
'use strict';

/*
  createBusiness - Realtime Database (Netlify function)
  - POST JSON { businessName, email?, desiredSlug?, plan? }
  - Header Idempotency-Key optional
  - Uses RTDB transaction to reserve /slugs/<slug>, multi-path update to write tenant data
  - Generates Firebase custom token for admin (tenant_admin:<tenantId>)
  - Ensures firebase-admin is initialized with databaseURL from env; will re-init if necessary
*/

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  theme: { color: '#8b5cf6', logo: null },
  features: {},
  timezone: 'UTC'
};

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*', // tighten in prod
  'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key'
};

function resp(statusCode, payload) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(payload) };
}

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  const n = name.normalize ? name.normalize('NFKD') : name;
  const stripped = n.replace(/[\u0300-\u036f]/g, '');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  return slug || '';
}
function shortId(len = 4) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/* ---------- Robust admin init ---------- */
async function ensureAdmin() {
  // try to require firebase-admin (most reliable)
  let admin;
  try { admin = require('firebase-admin'); } catch (e) { throw new Error('firebase-admin module missing'); }

  // Helper to parse service account from env (base64 or raw JSON)
  function parseServiceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || null;
    if (!raw) return null;
    // try base64 decode then parse, else parse raw JSON
    try {
      const maybe = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(maybe);
    } catch (err) {
      try { return JSON.parse(raw); } catch (err2) { return null; }
    }
  }

  const desiredDbUrl = (process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || '').trim();
  if (!desiredDbUrl && !process.env.FIREBASE_DATABASE_EMULATOR_HOST && !process.env.RTDB_EMULATOR_HOST) {
    throw new Error('Missing FIREBASE_DATABASE_URL environment variable (or RTDB emulator env).');
  }

  // If admin already initialized, check databaseURL
  if (admin.apps && admin.apps.length > 0) {
    try {
      const app = admin.app();
      const currentDb = (app && app.options && (app.options.databaseURL || app.options.databaseUrl)) || null;
      // If currentDb matches desiredDbUrl (or emulator present), return admin
      if (currentDb && desiredDbUrl && currentDb === desiredDbUrl) {
        return admin;
      }
      // If emulator env present, treat as valid
      if (process.env.FIREBASE_DATABASE_EMULATOR_HOST || process.env.RTDB_EMULATOR_HOST) {
        return admin;
      }

      // existing app but missing/incorrect databaseURL -> delete and re-init
      try {
        await app.delete();
        // clear require cache for firebase-admin module to ensure clean state if needed
      } catch (delErr) {
        console.warn('Warning: failed to delete existing firebase app before reinit:', delErr && delErr.message);
        // we'll still attempt to init below; if it fails we'll surface error
      }
    } catch (e) {
      // proceed to init
    }
  }

  // init admin with databaseURL and service account
  const saObj = parseServiceAccount();
  const dbUrl = desiredDbUrl || (process.env.FIREBASE_DATABASE_EMULATOR_HOST ? `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}` : null);

  if (saObj) {
    // initialize with service account + databaseURL
    admin.initializeApp({
      credential: admin.credential.cert(saObj),
      ...(dbUrl ? { databaseURL: dbUrl } : {})
    });
    return admin;
  }

  // If service account not provided, try default init (works with GOOGLE_APPLICATION_CREDENTIALS)
  try {
    admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return admin;
  } catch (e) {
    throw new Error('Failed to initialize firebase-admin. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or set GOOGLE_APPLICATION_CREDENTIALS.');
  }
}

/* ---------- Main handler ---------- */
exports.handler = async function(event, context) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: { ...HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
    }
    if (event.httpMethod !== 'POST') return resp(405, { error: 'method_not_allowed', message: 'Use POST' });

    // parse body
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { return resp(400, { error: 'invalid_json' }); }

    const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'])) || 'unknown';
    const ua = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';

    const businessName = (body.businessName || '').trim();
    const email = (body.email || '').trim() || null;
    const desiredSlug = (body.desiredSlug || '').trim() || null;
    const plan = (body.plan || 'free').trim();

    if (!businessName) return resp(400, { error: 'businessName_required' });
    if (businessName.length > 200) return resp(400, { error: 'businessName_too_long' });

    const idempotencyKey = (event.headers && (event.headers['Idempotency-Key'] || event.headers['idempotency-key'])) || null;

    // ensure admin is initialized properly
    let admin;
    try {
      admin = await ensureAdmin();
    } catch (e) {
      console.error('admin init error:', e && (e.stack || e.message || e));
      return resp(500, { error: 'firebase_admin_init_failed', message: String(e && e.message) });
    }

    // get RTDB handle
    const db = admin.database();

    // idempotency early check
    if (idempotencyKey) {
      try {
        const snap = await db.ref(`/idempotency/${idempotencyKey}`).once('value');
        if (snap && snap.exists()) {
          const v = snap.val();
          return resp(200, { tenantId: v.tenantId, slug: v.slug, adminToken: v.adminToken || null, from: 'idempotency' });
        }
      } catch (e) {
        console.warn('idempotency read failed, continuing:', e && e.message);
      }
    }

    // slug base
    let baseSlug = desiredSlug ? slugify(desiredSlug) : slugify(businessName);
    if (!baseSlug) baseSlug = `biz-${shortId(5)}`;

    const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || '/tenants').replace(/^\/+|\/+$/g, '');
    const slugsPrefix = '/slugs';

    // Reserve slug via transaction (on single key)
    let reservedSlug = null;
    const maxTries = 10;
    for (let attempt = 0; attempt < maxTries && !reservedSlug; attempt++) {
      const slugAttempt = attempt === 0 ? baseSlug : `${baseSlug}-${shortId(3)}`;
      const slugRef = db.ref(`${slugsPrefix}/${slugAttempt}`);

      try {
        const tx = await slugRef.transaction(current => {
          if (current === null) {
            return { reserved: true, reservedAt: admin.database.ServerValue.TIMESTAMP || Date.now() };
          }
          return; // abort
        }, { applyLocally: false });

        if (tx.committed) {
          reservedSlug = slugAttempt;
          break;
        }
      } catch (e) {
        console.warn('slug transaction attempt failed, retrying:', e && e.message);
        // try next suffix
      }
    }

    if (!reservedSlug) return resp(500, { error: 'slug_generation_failed', message: 'Could not reserve unique slug' });

    // create tenant push id
    const tenantRef = db.ref(`${basePath}`).push();
    const tenantId = tenantRef.key;
    const serverTs = admin.database.ServerValue.TIMESTAMP;

    // prepare multi-path update
    const updates = {};
    updates[`/${basePath}/${tenantId}`] = {
      name: businessName,
      ownerEmail: email,
      plan,
      slug: reservedSlug,
      createdAt: serverTs
    };
    updates[`/${basePath}/${tenantId}/public/config`] = { ...DEFAULT_CONFIG, ownerEmail: email || null, createdAt: serverTs };
    updates[`/${basePath}/${tenantId}/queues/meta`] = { nextTicket: 1, totalWaiting: 0, createdAt: serverTs };
    updates[`/slugs/${reservedSlug}`] = { tenantId, createdAt: serverTs };
    const auditKey = db.ref('/audit').push().key;
    updates[`/audit/${auditKey}`] = { action: 'tenant_create', tenantId, tenantSlug: reservedSlug, ip, ua, by: email || 'unknown', createdAt: serverTs };
    if (idempotencyKey) {
      updates[`/idempotency/${idempotencyKey}`] = { tenantId, slug: reservedSlug, createdAt: serverTs };
    }

    // perform update
    try {
      await db.ref().update(updates);
    } catch (updateErr) {
      // rollback reserved slug (best-effort)
      try { await db.ref(`/slugs/${reservedSlug}`).remove(); } catch (e) { console.error('rollback slug failed', e && e.message); }
      console.error('update failed', updateErr && (updateErr.stack || updateErr.message || updateErr));
      return resp(500, { error: 'write_failed', message: 'Failed to persist tenant data' });
    }

    // generate admin custom token
    let adminToken = null;
    try {
      const adminUid = `tenant_admin:${tenantId}`;
      adminToken = await admin.auth().createCustomToken(adminUid, { role: 'admin', tenantId });
      if (idempotencyKey) {
        try { await db.ref(`/idempotency/${idempotencyKey}/adminToken`).set(adminToken); } catch (e) { console.warn('store adminToken fail', e && e.message); }
      }
    } catch (e) {
      console.warn('createCustomToken failed (non-fatal):', e && e.message);
      // continue, tenant exists
    }

    return resp(201, { tenantId, slug: reservedSlug, adminToken });

  } catch (err) {
    console.error('createBusiness: unexpected', err && (err.stack || err));
    return resp(500, { error: 'internal_error', message: String(err && err.message) });
  }
};
