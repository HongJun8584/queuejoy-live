/*
 Safer Firebase Admin initializer.
 - If FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT is present and valid JSON,
   initialize admin normally.
 - Otherwise export a stub admin object that indicates uninitialized state.
 The rest of the functions can check admin.__initialized to decide behavior.
*/
const adminPkg = require('firebase-admin');

function tryParseServiceAccount() {
  const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (rawBase64) {
    try {
      const decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:', e && e.message);
    }
  }
  if (rawJson) {
    try { return JSON.parse(rawJson); } catch (e) { console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e && e.message); }
  }
  return null;
}

let initialized = false;
let admin = null;

try {
  const serviceAccount = tryParseServiceAccount();
  if (serviceAccount) {
    const dbUrl = process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || null;
    if (!adminPkg.apps || adminPkg.apps.length === 0) {
      adminPkg.initializeApp({
        credential: adminPkg.credential.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }
    admin = adminPkg;
    initialized = true;
    console.log('firebaseAdmin: initialized successfully');
  } else {
    // no service account provided -> do not throw, export stub
    admin = {
      __initialized: false,
      database: () => { throw new Error('Firebase is not configured on this environment. Provide FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT env var.'); },
      auth: () => { throw new Error('Firebase auth is not configured.'); }
    };
    initialized = false;
    console.warn('firebaseAdmin: no service account found; exporting stub admin object');
  }
} catch (err) {
  console.error('firebaseAdmin: initialization error', err && err.stack || err);
  admin = {
    __initialized: false,
    database: () => { throw new Error('Firebase init error: ' + (err && err.message)); },
    auth: () => { throw new Error('Firebase init error: ' + (err && err.message)); }
  };
  initialized = false;
}

admin.__initialized = initialized;

module.exports = admin;
