// tenant-template/functions/get-tenant.js
// CommonJS style for Netlify functions
const admin = require('firebase-admin');

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT env var not set');

  // try base64 decode
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed;
  } catch (e) {
    // fallback: try to parse raw JSON
    try {
      return JSON.parse(raw);
    } catch (e2) {
      throw new Error('Failed to parse Firebase service account JSON (check env var format)');
    }
  }
}

let firebaseApp = null;
function initAdmin() {
  if (firebaseApp) return firebaseApp;
  const serviceAccount = parseServiceAccount();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || 'https://queuejoy-live-default-rtdb.asia-southeast1.firebasedatabase.app';
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  }, `get-tenant-${Date.now()}`); // unique name to avoid re-init conflicts
  return firebaseApp;
}

exports.handler = async function(event, context) {
  // CORS headers (adjust origin as needed)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Content-Type': 'application/json'
  };

  try {
    // Master key check (for testing). Accept either query param master_key or header x-master-key.
    const qs = event.queryStringParameters || {};
    const incomingKey = (qs.master_key || qs.masterKey || (event.headers && event.headers['x-master-key'])) || null;
    const MASTER_KEY = process.env.MASTER_API_KEY || null;

    if (!MASTER_KEY || incomingKey !== MASTER_KEY) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'invalid or missing master key' }) };
    }

    const slug = qs.slug;
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing slug param' }) };
    }

    initAdmin();
    const db = admin.database();
    const ref = db.ref(`/tenants/${slug}`);
    const snap = await ref.once('value');
    const tenant = snap.val();

    if (!tenant) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'tenant not found' }) };
    }

    // Optionally sanitize tenant data if there are secrets you don't want to surface
    return { statusCode: 200, headers, body: JSON.stringify(tenant) };
  } catch (err) {
    console.error('get-tenant error:', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'internal error' }) };
  }
};
