/*
  firebaseAdmin.js - initialize firebase-admin with FIREBASE_SERVICE_ACCOUNT_BASE64 env var.
  - Supports:
    * FIREBASE_SERVICE_ACCOUNT_BASE64 (base64-encoded JSON)
    * FIREBASE_SERVICE_ACCOUNT (raw JSON string)
    * FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON string)
  - Uses FIREBASE_DATABASE_URL if present, otherwise derives from serviceAccount.project_id when possible.
  - Sets admin.__initialized = true on successful initialization so other modules can detect readiness.
*/
const admin = require('firebase-admin');

if (admin && admin.apps && admin.apps.length > 0) {
  // If already initialized in this lambda instance, set flag and export
  admin.__initialized = true;
  module.exports = admin;
  return;
}

function tryParseServiceAccountFromEnv() {
  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    process.env.FIREBASE_SERVICE_ACCOUNT,
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ].filter(Boolean);

  for (const raw of candidates) {
    // base64 candidate detection: typical base64 charset and length mod 4 == 0
    try {
      if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, '').length % 4 === 0) {
        // try decode base64
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        try { return JSON.parse(dec); } catch (e) { /* fallthrough */ }
      }
    } catch (e) { /* ignore */ }
    // try raw JSON parse
    try { return JSON.parse(raw); } catch (e) { /* ignore */ }
  }
  return null;
}

try {
  const serviceAccount = tryParseServiceAccountFromEnv();
  const envDbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || null;
  const dbUrl = envDbUrl || (serviceAccount && serviceAccount.project_id ? `https://${serviceAccount.project_id}.firebaseio.com` : null);

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      ...(dbUrl ? { databaseURL: dbUrl } : {})
    });
    admin.__initialized = true;
    module.exports = admin;
    return;
  }

  // No explicit service account provided: try default application credentials (in GCP environments)
  // If FIREBASE_DATABASE_URL is provided, initialize with it (useful if Netlify env has DB URL and metadata)
  if (dbUrl) {
    admin.initializeApp({ databaseURL: dbUrl });
    admin.__initialized = true;
    module.exports = admin;
    return;
  }

  // If we get here, we can't initialize admin. Export the admin object uninitialized
  console.error('firebase-admin not initialized: no service account or database URL found in environment.');
  module.exports = admin;
} catch (err) {
  console.error('Failed to init firebase admin:', err && (err.stack || err.message || err));
  module.exports = admin;
}