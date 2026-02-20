'use strict';

/*
  createBusiness - Realtime Database (Netlify function)
  - Writes to recommended production RTDB layout:
      /slugs/<slug> -> { tenantId, reservedAt }
      /tenants/<tenantId>/meta -> { name, slug, ownerEmail, plan, createdAt, updatedAt, billing... }
      /tenants/<tenantId>/public/config -> client-safe config (no ownerEmail)
      /tenants/<tenantId>/queueMeta -> { nextTicket, totalWaiting, createdAt }
      /tenants/<tenantId>/counters  (empty)
      /tenants/<tenantId>/queues    (empty)
      /tenants/<tenantId>/analytics/serviceEvents (empty)
      /tenants/<tenantId>/integrations/telegram/...
      /idempotency/<key>
      /audit/<auditId>
  - Robust initialization, transaction-based slug reservation, safe multi-path update with retry
*/

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  theme: { color: '#8b5cf6', logo: null },
  features: {},
  timezone: 'UTC',
  displayName: null // will set to businessName for client display
};

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key'
};

const DEBUG = !!(process.env.DEBUG && process.env.DEBUG !== 'false');

function resp(statusCode, payload) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(payload) };
}

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  const n = name.normalize ? name.normalize('NFKD') : name;
  const stripped = n.replace(/[̀-\u036f]/g, '');
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
  let admin;
  try { admin = require('firebase-admin'); } catch (e) { throw new Error('firebase-admin module missing'); }

  function parseServiceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || null;
    if (!raw) return null;
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

  if (admin.apps && admin.apps.length > 0) {
    try {
      const app = admin.app();
      const currentDb = (app && app.options && (app.options.databaseURL || app.options.databaseUrl)) || null;
      if (currentDb && desiredDbUrl && currentDb === desiredDbUrl) {
        return admin;
      }
      if (process.env.FIREBASE_DATABASE_EMULATOR_HOST || process.env.RTDB_EMULATOR_HOST) {
        return admin;
      }
      try { await app.delete(); } catch (delErr) { console.warn('Warning: failed to delete existing firebase app before reinit:', delErr && delErr.message); }
    } catch (e) {
      // continue to init
    }
  }

  const saObj = parseServiceAccount();
  const dbUrl = desiredDbUrl || (process.env.FIREBASE_DATABASE_EMULATOR_HOST ? `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}` : null);

  if (saObj) {
    admin.initializeApp({
      credential: admin.credential.cert(saObj),
      ...(dbUrl ? { databaseURL: dbUrl } : {})
    });
    return admin;
  }

  try {
    admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
    return admin;
  } catch (e) {
    throw new Error('Failed to initialize firebase-admin. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or set GOOGLE_APPLICATION_CREDENTIALS.');
  }
}

/* ---------- Helper: Admin-transaction wrapper for Admin SDK ---------- */
function runTransactionPromise(ref, updateFunction, applyLocally = false) {
  return new Promise((resolve, reject) => {
    try {
      ref.transaction(updateFunction, (error, committed, snapshot) => {
        if (error) return reject(error);
        return resolve({ committed, snapshot });
      }, applyLocally);
    } catch (ex) {
      reject(ex);
    }
  });
}

/* ---------- Safe update with retries and fallback ---------- */
async function safeUpdate(db, updates, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const baseBackoff = opts.baseBackoff || 150; // ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.ref().update(updates);
      return { ok: true, multi: true };
    } catch (err) {
      console.error(`safeUpdate attempt=${attempt} failed:`, err && (err.code || err.message || err));
      if (attempt < maxAttempts) {
        const backoff = baseBackoff * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      // final failure -> fallback to sequential writes
      break;
    }
  }

  // Fallback: try sequential writes to reduce chance of multi-path related failures.
  const writtenKeys = [];
  try {
    const keys = Object.keys(updates).sort();
    for (const path of keys) {
      const trimmed = path.replace(/^\/+/, '');
      const ref = db.ref(trimmed);
      await ref.set(updates[path]);
      writtenKeys.push(trimmed);
    }
    return { ok: true, sequential: true, writtenKeys };
  } catch (seqErr) {
    console.error('safeUpdate sequential fallback failed:', seqErr && (seqErr.code || seqErr.message || seqErr));
    // attempt rollback of any partial writes
    for (const k of writtenKeys) {
      try { await db.ref(k).remove(); } catch (e) { console.warn('rollback remove failed for', k, e && e.message); }
    }
    return { ok: false, error: seqErr };
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
    const purchaseInfo = body.purchaseInfo && typeof body.purchaseInfo === 'object' ? body.purchaseInfo : null; // optional billing info

    if (!businessName) return resp(400, { error: 'businessName_required' });
    if (businessName.length > 200) return resp(400, { error: 'businessName_too_long' });

    const idempotencyKey = (event.headers && (event.headers['Idempotency-Key'] || event.headers['idempotency-key'])) || null;

    // init admin
    let admin;
    try {
      admin = await ensureAdmin();
    } catch (e) {
      console.error('admin init error:', e && (e.stack || e.message || e));
      return resp(500, { error: 'firebase_admin_init_failed', message: String(e && e.message) });
    }

    const db = admin.database();

    // idempotency early check
    if (idempotencyKey) {
      try {
        const snap = await db.ref(`/idempotency/${idempotencyKey}`).once('value');
        if (snap && snap.exists && snap.val()) {
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

    const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || 'tenants').replace(/^\/+|\/+$/g, '');
    const slugsPrefix = (process.env.SLUGS_PATH || process.env.SLUG_PATH || 'slugs').replace(/^\/+|\/+$/g, '');
    const slugsRefPrefix = `/${slugsPrefix}`;

    // Reserve slug via transaction (on single key)
    let reservedSlug = null;
    const maxTries = 20;
    const baseBackoffMs = 100;
    for (let attempt = 0; attempt < maxTries && !reservedSlug; attempt++) {
      const slugAttempt = attempt === 0 ? baseSlug : `${baseSlug}-${shortId(3)}`;
      const slugRef = db.ref(`${slugsRefPrefix}/${slugAttempt}`);

      try {
        const tx = await runTransactionPromise(slugRef, current => {
          if (current === null) {
            return { tenantId: true, reservedAt: admin.database.ServerValue.TIMESTAMP || Date.now() }; // placeholder; final value set in multi-path update
          }
          return; // abort - key exists
        }, false);

        console.log(`slug tx attempt=${attempt} slug=${slugAttempt} committed=${tx && tx.committed}`);
        if (tx && tx.committed) {
          reservedSlug = slugAttempt;
          break;
        } else {
          try { const snap = await slugRef.once('value'); console.warn('slug tx not committed, existing value for', slugAttempt, snap && snap.val()); } catch (snErr) { console.warn('slugRef.once failed during diagnostic read', snErr && (snErr.message || snErr)); }
        }
      } catch (e) {
        console.error(`slug transaction error on attempt=${attempt} slugAttempt=${slugAttempt}:`, (e && (e.stack || e.message || e)));
      }

      const backoff = baseBackoffMs * Math.pow(2, Math.min(attempt, 8));
      await new Promise(r => setTimeout(r, backoff));
    }

    if (!reservedSlug) {
      console.error('slug_generation_failed: reached max tries; inspect /slugs and RTDB rules.');
      return resp(500, { error: 'slug_generation_failed', message: 'Could not reserve unique slug' });
    }

    // create tenant push id
    const tenantRef = db.ref(`${basePath}`).push();
    const tenantId = tenantRef.key;
    const serverTs = admin.database.ServerValue.TIMESTAMP;

    // Prepare multi-path update according to final structure
    const updates = {};

    // tenant meta
    const metaPath = `/${basePath}/${tenantId}/meta`;
    const metaObj = {
      name: businessName,
      slug: reservedSlug,
      ownerEmail: email || null,
      plan,
      createdAt: serverTs,
      updatedAt: serverTs
    };
    if (purchaseInfo && purchaseInfo.purchasedAt) {
      metaObj.billing = {
        purchasedAt: purchaseInfo.purchasedAt,
        expiresAt: purchaseInfo.expiresAt || null,
        price: purchaseInfo.price || null,
        invoiceId: purchaseInfo.invoiceId || null
      };
    }

    updates[metaPath] = metaObj;

    // public config (client-safe: NO ownerEmail)
    const publicConfigPath = `/${basePath}/${tenantId}/public/config`;
    const configObj = Object.assign({}, DEFAULT_CONFIG, { displayName: businessName, createdAt: serverTs });
    updates[publicConfigPath] = configObj;

    // queueMeta (NOT under queues)
    const queueMetaPath = `/${basePath}/${tenantId}/queueMeta`;
    updates[queueMetaPath] = { nextTicket: 1, totalWaiting: 0, createdAt: serverTs };

    // empty containers for future nodes (optional to create now)
    updates[`/${basePath}/${tenantId}/counters`] = {}; // ready to accept counters
    updates[`/${basePath}/${tenantId}/queues`] = {};   // ready to accept tickets
    updates[`/${basePath}/${tenantId}/analytics/serviceEvents`] = {}; // events storage
    updates[`/${basePath}/${tenantId}/integrations`] = {
      telegram: { tokens: {}, connected: {} }
    };

    // set slug mapping to tenantId (overwrite placeholder from tx)
    updates[`/${slugsPrefix}/${reservedSlug}`] = { tenantId, createdAt: serverTs };

    // audit entry (global admin audit)
    const auditKey = db.ref('/audit').push().key;
    updates[`/audit/${auditKey}`] = {
      action: 'tenant_create',
      tenantId,
      tenantSlug: reservedSlug,
      ip,
      ua,
      by: email || 'unknown',
      createdAt: serverTs
    };

    // idempotency record
    if (idempotencyKey) {
      updates[`/idempotency/${idempotencyKey}`] = { tenantId, slug: reservedSlug, createdAt: serverTs };
    }

    // perform update (safe)
    let updateResult;
    try {
      updateResult = await safeUpdate(db, updates, { maxAttempts: 3, baseBackoff: 200 });
      if (!updateResult.ok) {
        console.error('safeUpdate ultimately failed', updateResult.error || 'unknown');
        // best-effort rollback - remove slug reservation if possible
        try { await db.ref(`/${slugsPrefix}/${reservedSlug}`).remove(); } catch (e) { console.error('rollback slug failed after safeUpdate failure', e && e.message); }
        return resp(500, { error: 'write_failed', message: 'Failed to persist tenant data' });
      }
    } catch (updateErr) {
      console.error('update failed', updateErr && (updateErr.stack || updateErr.message || updateErr));
      try { await db.ref(`/${slugsPrefix}/${reservedSlug}`).remove(); } catch (e) { console.error('rollback slug failed', e && e.message); }
      return resp(500, { error: 'write_failed', message: 'Failed to persist tenant data' });
    }

    // generate admin custom token (best-effort, non-fatal)
    let adminToken = null;
    try {
      const adminUid = `tenant_admin:${tenantId}`;
      adminToken = await admin.auth().createCustomToken(adminUid, { role: 'admin', tenantId });
      if (idempotencyKey) {
        try { await db.ref(`/idempotency/${idempotencyKey}/adminToken`).set(adminToken); } catch (e) { console.warn('store adminToken fail', e && e.message); }
      }
    } catch (e) {
      console.warn('createCustomToken failed (non-fatal):', e && e.message);
    }

    // success
    return resp(201, { tenantId, slug: reservedSlug, adminToken });

  } catch (err) {
    console.error('createBusiness: unexpected', err && (err.stack || err));
    const safeMessage = DEBUG ? String(err && err.message) : 'internal_error';
    return resp(500, { error: 'internal_error', message: safeMessage });
  }
};