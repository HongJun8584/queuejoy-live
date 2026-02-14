// netlify/functions/get-firebase-config.js
// Node 18+ runtime expected

const admin = require('firebase-admin');

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function parseServiceAccountFromEnv() {
  const candidates = [
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_BASE64',
    'FIREBASE_SA',
    'FIREBASE_SA_BASE64'
  ];
  for (const name of candidates) {
    const raw = process.env[name];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed[0] === '{') {
      const parsed = tryParseJson(raw);
      if (parsed) return parsed;
    } else {
      try {
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        const parsed = tryParseJson(dec);
        if (parsed) return parsed;
      } catch {}
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    return { type: 'service_account', project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }
  return null;
}

/* ---------- Firebase lazy init (same pattern as createBusiness) ---------- */
let initialized = false;
let initError = null;
async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) return { admin, db: admin.database() };
  if (initError) throw initError;
  try {
    const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL;
    if (!dbUrl) throw new Error('FIREBASE_DB_URL is not set in environment');
    const serviceAccount = parseServiceAccountFromEnv();
    if (!serviceAccount) throw new Error('Firebase service account not found in environment');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }
    initialized = true;
    return { admin, db: admin.database() };
  } catch (e) {
    initError = e instanceof Error ? e : new Error(String(e));
    throw initError;
  }
}

/* ---------- Handler ---------- */
exports.handler = async function (event) {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } };
    }

    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'method_not_allowed', message: 'Only GET allowed' });

    const qs = event.queryStringParameters || {};
    const slug = (qs.slug || '').toString().trim();
    if (!slug) return jsonResponse(400, { error: 'missing_slug', message: 'Provide ?_
