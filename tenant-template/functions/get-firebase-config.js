/* get-firebase-config.js - netlify function with simple in-memory cache + logs */
/* Expects tenant client config at Firestore path: tenants/<slug>/public/config */
const admin = require('./lib/firebaseAdmin');
const headers = { 'Content-Type': 'application/json' };

// In-memory module-scope cache (will live during function container lifetime)
const CACHE = {
  data: {},        // slug -> { config, expiresAt }
  ttlMs: 60 * 1000 // default 60s; adjust if needed
};

exports.handler = async function(event) {
  try {
    const slug = (event.queryStringParameters && event.queryStringParameters.slug) || null;
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing slug' }) };
    }

    // serve from cache if present & fresh
    const cached = CACHE.data[slug];
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`get-firebase-config: cache hit for ${slug}`);
      return { statusCode: 200, headers, body: JSON.stringify(cached.config) };
    }

    console.log(`get-firebase-config: fetching config for ${slug}`);
    // Make sure admin is initialized (lib should handle missing env gracefully)
    const db = admin.firestore ? admin.firestore() : null;
    if (!db) {
      console.error('get-firebase-config: firebase admin not initialized');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'internal' }) };
    }

    const docRef = db.doc(`tenants/${slug}/public/config`);
    const doc = await docRef.get();
    if (!doc.exists) {
      console.warn(`get-firebase-config: tenant not found ${slug}`);
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'tenant not found' }) };
    }

    const cfg = doc.data() || {};
    // remove sensitive keys if present
    delete cfg.serviceAccount;
    delete cfg.adminKey;

    // cache result
    CACHE.data[slug] = { config: cfg, expiresAt: Date.now() + CACHE.ttlMs };
    console.log(`get-firebase-config: cached config for ${slug} (ttl ${CACHE.ttlMs}ms)`);

    return { statusCode: 200, headers, body: JSON.stringify(cfg) };
  } catch (err) {
    console.error('get-firebase-config error', err && (err.stack || err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'internal' }) };
  }
};
