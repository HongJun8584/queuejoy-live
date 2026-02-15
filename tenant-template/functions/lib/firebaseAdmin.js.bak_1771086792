/*
 Shared Firebase Admin initializer for Netlify functions.
 Expects either FIREBASE_SERVICE_ACCOUNT_BASE64 (base64-encoded JSON) OR FIREBASE_SERVICE_ACCOUNT (raw JSON).
 Also reads FIREBASE_DB_URL or FIREBASE_DATABASE_URL for databaseURL.
*/
const admin = require('firebase-admin');

function parseServiceAccount() {
  const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (rawBase64) {
    try {
      const decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (e) {
      // fallthrough
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64', e && e.message);
    }
  }
  if (rawJson) {
    try { return JSON.parse(rawJson); } catch (e) { console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT', e && e.message); }
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT env var must be set and valid JSON');
}

if (!admin.apps || admin.apps.length === 0) {
  const serviceAccount = parseServiceAccount();
  const dbUrl = process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  });
}

module.exports = admin;
