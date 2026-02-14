// netlify/functions/get-firebase-config.js
const admin = require('firebase-admin');

let firebaseApp = null;

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT must be set');
  try {
    // try base64 decode first
    const maybeJson = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(maybeJson);
    return parsed;
  } catch (e) {
    // not base64 or failed parse — try parse raw
    try {
      return JSON.parse(raw);
    } catch (e2) {
      throw new Error('Failed to parse service account json');
    }
  }
}

function initAdmin() {
  if (firebaseApp) return firebaseApp;
  const serviceAccount = getServiceAccount();
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://queuejoy-live.firebaseio.com'
  }, 'get-firebase-config');
  return firebaseApp;
}

exports.handler = async function(event, context) {
  try {
    const slug = (event.queryStringParameters && event.queryStringParameters.slug) || (event.path && event.path.split('/').pop());
    if (!slug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'missing slug' }) };
    }
    initAdmin();
    const db = admin.database();
    const ref = db.ref(`/tenants/${slug}/firebaseConfig`);
    const snap = await ref.once('value');
    const cfg = snap.val();
    if (!cfg) {
      return { statusCode: 404, body: JSON.stringify({ error: 'firebaseConfig not found for slug' }) };
    }
    // return plain JSON (no sensitive keys like service account)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    };
  } catch (err) {
    console.error('get-firebase-config error', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'internal error' })
    };
  }
};
