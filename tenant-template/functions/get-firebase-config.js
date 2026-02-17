// tenant-template/functions/get-firebase-config.js
'use strict';

/*
  Defensive Netlify function to return tenant config from Firebase.
  - Supports FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 JSON) or raw FIREBASE_SERVICE_ACCOUNT (JSON string)
  - Uses FIREBASE_DATABASE_URL or FIREBASE_DB_URL for Realtime DB
  - Uses FIREBASE_PATH (default /tenants) to locate tenant
  - Safe: never throws unhandled; always returns JSON responses
*/

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

// Simple in-memory cache for the life of the function container
const CACHE = {
  data: {},        // slug -> { config, expiresAt }
  ttlMs: (() => {
    const v = parseInt(process.env.GET_CONFIG_CACHE_TTL_MS || '', 10);
    return Number.isFinite(v) && v > 0 ? v : 60 * 1000; // default 60s
  })()
};

// Try to require firebase-admin robustly.
// Prefer the top-level 'firebase-admin' if available, else try local lib.
let admin;
try {
  admin = require('firebase-admin');
} catch (e) {
  try {
    admin = require('./lib/firebaseAdmin'); // fallback to project helper if present
  } catch (e2) {
    admin = null;
  }
}

// Initialize admin if possible and not already initialized
function tryInitAdmin() {
  try {
    if (!admin) return { ok: false, reason: 'firebase-admin not available' };

    if (admin.apps && admin.apps.length > 0) {
      // already initialized
      return { ok: true, admin };
    }

    // Determine service account credentials
    let rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || null;
    let saObj = null;

    if (rawSa) {
      // try base64 decode then json parse; fall back to raw json parse
      try {
        // if it looks base64-ish, decode
        const maybe = Buffer.from(rawSa, 'base64').toString('utf8');
        try {
          saObj = JSON.parse(maybe);
        } catch (e) {
          // maybe rawSa already was JSON text (or base64 decode produced something else)
          try {
            saObj = JSON.parse(rawSa);
          } catch (e2) {
            // leave null
            saObj = null;
          }
        }
      } catch (e) {
        try {
          saObj = JSON.parse(rawSa);
        } catch (e2) {
          saObj = null;
        }
      }
    }

    const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || undefined;

    // If we have service account object, use it; otherwise try default initializer
    if (saObj) {
      admin.initializeApp({
        credential: admin.credential.cert(saObj),
        ...(dbUrl ? { databaseURL: dbUrl } : {})
      });
    } else {
      // try initialize without explicit credentials (works if GOOGLE_APPLICATION_CREDENTIALS is set in environment)
      try {
        admin.initializeApp({ ...(dbUrl ? { databaseURL: dbUrl } : {}) });
      } catch (e) {
        // swallow - will cause callers to handle admin missing or uninitialized
      }
    }

    return { ok: true, admin };
  } catch (err) {
    // fail safe
    return { ok: false, reason: 'init_failed', err };
  }
}

// safe clone
function safeClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj || {}; }
}

// remove secret-ish fields
function redactSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = safeClone(cfg);
  const secrets = ['serviceAccount', 'adminKey', 'privateKey', 'secret', 'apiKey', '_internal'];
  for (const k of secrets) {
    if (k in clone) delete clone[k];
  }
  return clone;
}

// Helper to build standardized responses
function resp(statusCode, payload) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload)
  };
}

// Main handler
exports.handler = async function (event) {
  try {
    // determine slug from query, path, or JSON body
    let slug = null;
    if (event && event.queryStringParameters && event.queryStringParameters.slug) {
      slug = String(event.queryStringParameters.slug).trim();
    } else if (event && event.pathParameters && event.pathParameters.slug) {
      slug = String(event.pathParameters.slug).trim();
    } else if (event && event.body) {
      try {
        const parsed = event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body);
        if (parsed && parsed.slug) slug = String(parsed.slug).trim();
      } catch (e) {
        // ignore body parse errors, not fatal
      }
    }

    if (!slug) {
      return resp(400, { error: 'missing slug' });
    }

    // check cache
    const cached = CACHE.data[slug];
    if (cached && cached.expiresAt > Date.now()) {
      // Return a deep clone for safety
      return resp(200, { source: 'cache', config: safeClone(cached.config) });
    }

    // init admin
    const init = tryInitAdmin();
    if (!init.ok || !init.admin) {
      // do not throw; return 500 with explanation
      return resp(500, { error: 'firebase_admin_unavailable', detail: init.reason || null });
    }

    const SDKadmin = init.admin;

    // Build path from env or default
    const basePath = (process.env.FIREBASE_PATH || process.env.TENANT_PATH || '/tenants').replace(/^\/+|\/+$/g, '');
    // for RTDB path: tenants/<slug>/public/config
    const rtdbPath = `${basePath}/${slug}/public/config`;
    // for Firestore doc path: tenants/<slug>/public/config
    const firestoreDocPath = `${basePath}/${slug}/public/config`;

    // Try Firestore first if available
    let config = null;
    try {
      if (typeof SDKadmin.firestore === 'function') {
        const db = SDKadmin.firestore();
        // Firestore doc read
        const docRef = db.doc(firestoreDocPath);
        const doc = await docRef.get().catch(() => null);
        if (doc && doc.exists) {
          config = doc.data();
        }
      }
    } catch (e) {
      // ignore; we'll try RTDB
      config = null;
    }

    // If not found in Firestore, try Realtime Database (if available)
    if (config == null && typeof SDKadmin.database === 'function') {
      try {
        const db = SDKadmin.database();
        const ref = typeof db.ref === 'function' ? db.ref(rtdbPath) : null;
        if (ref) {
          // prefer modern get if available on ref
          if (typeof ref.get === 'function') {
            const snap = await ref.get().catch(() => null);
            if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
              config = typeof snap.val === 'function' ? snap.val() : snap;
            }
          } else if (typeof ref.once === 'function') {
            const snap = await ref.once('value').catch(() => null);
            if (snap && (typeof snap.exists === 'function' ? snap.exists() : snap.val() != null)) {
              config = typeof snap.val === 'function' ? snap.val() : snap;
            }
          }
        }
      } catch (e) {
        // swallow; we'll handle not found below
        config = null;
      }
    }

    // If still null => not found
    if (config == null) {
      return resp(404, { error: 'tenant not found', pathTried: { firestoreDocPath, rtdbPath } });
    }

    // sanitize
    const safeCfg = redactSecrets(config);

    // cache
    try {
      CACHE.data[slug] = { config: safeCfg, expiresAt: Date.now() + CACHE.ttlMs };
    } catch (e) {
      // ignore caching errors
    }

    return resp(200, { source: 'db', config: safeClone(safeCfg) });
  } catch (err) {
    // catch-all: never let an exception bubble up unhandled
    try {
      // log to stdout so Netlify UI deploy logs capture it
      console.error('get-firebase-config: unexpected error', (err && (err.stack || err)));
    } catch (e) { /* no-op */ }
    return resp(500, { error: 'internal', message: 'unexpected error' });
  }
};
