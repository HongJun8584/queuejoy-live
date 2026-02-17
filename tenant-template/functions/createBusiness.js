// tenant-template/functions/createBusiness.js
'use strict';

/*
  createBusiness for Realtime Database (Netlify function style)

  Behavior:
  - Accepts POST JSON { businessName, email?, desiredSlug?, plan? }
  - Optional header: Idempotency-Key to make retries safe
  - Generates slug (slugify) and reserves it via RTDB transaction on /slugs/<slug>
  - Generates tenantId via push().key and writes tenant data + config + queues/meta + idempotency mapping in one multi-path update
  - Creates Firebase custom token for admin user (tenant_admin:<tenantId>)
  - Cleans up reserved slug if final multi-path update fails (best-effort)
  - Returns JSON with tenantId, slug, adminToken
*/

const crypto = require('crypto');

// Use your project's firebaseAdmin helper - this file should export initialized admin (or lazy init)
let admin;
try {
  admin = require('./lib/firebaseAdmin'); // expected to export admin instance
} catch (e) {
  // fallback to requiring firebase-admin directly (if lib not present)
  try {
    admin = require('firebase-admin');
  } catch (e2) {
    admin = null;
  }
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*', // adjust in prod to specific domain(s)
  'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key'
};

function resp(statusCode, payload) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload)
  };
}

// slugify: normalize name -> ascii lowercase slug
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

const DEFAULT_CONFIG = {
  theme: { color: '#8b5cf6', logo: null },
  features: {},
  timezone: 'UTC'
};

exports.handler = async function(event, context) {
  try {
    // Allow OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: ''
      };
    }

    if (event.httpMethod !== 'POST') {
      return resp(405, { error: 'method_not_allowed', message: 'Use POST' });
    }

    // parse body
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return resp(400, { error: 'invalid_json' });
    }

    const ip = (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'])) || 'unknown';
    const ua = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';

    const businessName = (body.businessName || '').trim();
    const email = (body.email || '').trim() || null;
    const desiredSlug = (body.desiredSlug || '').trim() || null;
    const plan = (body.plan || 'free').trim();

    if (!businessName) return resp(400, { error: 'businessName_required' });
    if (businessName.length > 200) return resp(400, { error: 'businessName_too_long' });

    // Idempotency key (header)
    const idempotencyKey = (event.headers && (event.headers['Idempotency-Key'] || event.headers['idempotency-key'])) || null;

    // initialize admin
    if (!admin) {
      console.error('firebase-admin not available or lib/firebaseAdmin failed to load.');
      return resp(500, { error: 'server_misconfiguration', message: 'firebase admin not available' });
    }
    // If your lib exports an object that has database() etc, use it. If lib exports {admin}, adapt accordingly.
    const sdk = (admin.database && admin.ref) ? admin : (admin.admin && admin.admin.database ? admin.admin : admin);
    // above line tries to be tolerant; ideally lib/firebaseAdmin exports admin instance.
    if (!sdk || typeof sdk.database !== 'function') {
      return resp(500, { error: 'firebase_admin_init_failed', message: 'admin.database() unavailable' });
    }
    const db = sdk.database();

    // If idempotencyKey provided, try returning existing mapping (best-effort)
    if (idempotencyKey) {
      try {
        const idempSnap = await db.ref(`/idempotency/${idempotencyKey}`).once('value');
        if (idempSnap && idempSnap.exists()) {
          const existing = idempSnap.val();
          // If mapping found and contains tenantId+slug, return it. adminToken may be present.
          return resp(200, { tenantId: existing.tenantId, slug: existing.slug, adminToken: existing.adminToken || null, from: 'idempotency' });
        }
      } catch (e) {
        // log and continue - idempotency check failed but not fatal
        console.warn('idempotency check failed', e && e.message);
      }
    }

    // slug base
    let baseSlug = desiredSlug ? slugify(desiredSlug) : slugify(businessName);
    if (!baseSlug) baseSlug = `biz-${shortId(5)}`;

    // constants / path base
    const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || '/tenants').replace(/^\/+|\/+$/g, '');
    const slugsPathPrefix = '/slugs'; // we keep slug->tenantId mapping here
    const slugsRefRoot = db.ref(slugsPathPrefix); // e.g. /slugs

    // Try to reserve a slug via RTDB transaction on /slugs/<slug>.
    // We'll attempt up to N tries, appending shortId suffix on collisions.
    let reservedSlug = null;
    let tries = 0;
    const maxTries = 10;
    while (!reservedSlug && tries < maxTries) {
      const slugAttempt = tries === 0 ? baseSlug : `${baseSlug}-${shortId(3)}`;
      const slugRef = db.ref(`${slugsPathPrefix}/${slugAttempt}`);

      // Use transaction to set if null; transaction runs only on this path (atomic for that key)
      const txResult = await slugRef.transaction(current => {
        if (current === null) {
          // reserve with placeholder; actual tenantId will be set after we create tenant
          return { reserved: true, reservedAt: admin.database.ServerValue.TIMESTAMP || Date.now() };
        }
        // already taken
        return; // abort transaction (no change)
      }, { applyLocally: false });

      if (txResult.committed) {
        // success reserved
        reservedSlug = slugAttempt;
        break;
      } else {
        tries++;
        continue;
      }
    }

    if (!reservedSlug) {
      return resp(500, { error: 'slug_generation_failed', message: 'Could not reserve unique slug' });
    }

    // generate tenantId (push key) without writing yet
    const tenantRef = db.ref(`${basePath}`).push();
    const tenantId = tenantRef.key;
    const now = Date.now();
    const serverTs = admin.database.ServerValue.TIMESTAMP;

    // prepare multi-path update for tenant creation
    const updates = {};

    // tenant root
    updates[`/${basePath}/${tenantId}`] = {
      name: businessName,
      ownerEmail: email,
      plan,
      slug: reservedSlug,
      createdAt: serverTs
    };

    // tenant public config
    updates[`/${basePath}/${tenantId}/public/config`] = {
      ...DEFAULT_CONFIG,
      ownerEmail: email || null,
      createdAt: serverTs
    };

    // queues meta
    updates[`/${basePath}/${tenantId}/queues/meta`] = {
      nextTicket: 1,
      totalWaiting: 0,
      createdAt: serverTs
    };

    // slug mapping -> set real tenantId & createdAt (overwrite the placeholder set by transaction)
    updates[`/slugs/${reservedSlug}`] = {
      tenantId,
      createdAt: serverTs
    };

    // audit log entry (use push id)
    const auditRef = db.ref('/audit').push();
    updates[`/audit/${auditRef.key}`] = {
      action: 'tenant_create',
      tenantId,
      tenantSlug: reservedSlug,
      ip,
      ua,
      by: email || 'unknown',
      createdAt: serverTs
    };

    // idempotency mapping if provided
    if (idempotencyKey) {
      updates[`/idempotency/${idempotencyKey}`] = {
        tenantId,
        slug: reservedSlug,
        createdAt: serverTs
        // adminToken will be merged later (best-effort)
      };
    }

    // Attempt the multi-path update atomically
    try {
      await db.ref().update(updates);
    } catch (updateErr) {
      // If update fails, rollback slug reservation (best-effort)
      try {
        await db.ref(`/slugs/${reservedSlug}`).remove();
      } catch (remErr) {
        console.error('Failed to rollback reserved slug after update failure', remErr && remErr.stack || remErr);
      }
      console.error('Failed to write tenant data', updateErr && updateErr.stack || updateErr);
      return resp(500, { error: 'write_failed', message: 'Failed to persist tenant data' });
    }

    // Generate admin custom token for the tenant admin
    let adminToken = null;
    try {
      const adminUid = `tenant_admin:${tenantId}`;
      adminToken = await sdk.auth().createCustomToken(adminUid, { role: 'admin', tenantId });
      // best-effort: store adminToken in idempotency mapping (if exists)
      if (idempotencyKey) {
        try {
          await db.ref(`/idempotency/${idempotencyKey}/adminToken`).set(adminToken);
        } catch (e) {
          console.warn('Failed to persist adminToken to idempotency', e && e.message);
        }
      }
    } catch (e) {
      console.warn('createCustomToken failed', e && (e.message || e));
      // not fatal: we still return tenant and slug; front-end can request token via admin flow
    }

    // Success
    return resp(201, { tenantId, slug: reservedSlug, adminToken });

  } catch (err) {
    console.error('createBusiness error', err && (err.stack || err));
    return resp(500, { error: 'internal_error', message: String(err && err.message) });
  }
};
