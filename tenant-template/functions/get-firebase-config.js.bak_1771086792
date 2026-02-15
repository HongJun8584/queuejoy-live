/*
Return firebase config for front-end consumption.
Prefer process.env.FIREBASE_CONFIG, otherwise return minimal hint derived from envs.
*/
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Content-Type': 'application/json'
  };
  try {
    // auth optional for read-only; use master_key if set to protect endpoint
    const qs = event.queryStringParameters || {};
    const incomingKey = qs.master_key || (event.headers && event.headers['x-master-key']) || null;
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    if (MASTER_KEY && incomingKey !== MASTER_KEY) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'invalid or missing master key' }) };
    }

    if (process.env.FIREBASE_CONFIG) {
      try {
        const cfg = JSON.parse(process.env.FIREBASE_CONFIG);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, config: cfg }) };
      } catch (_) {
        // continue
      }
    }
    // fallback
    const fallback = {
      apiKey: process.env.FIREBASE_API_KEY || null,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
      databaseURL: process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || null,
      projectId: process.env.FIREBASE_PROJECT_ID || null
    };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, config: fallback }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'internal error' }) };
  }
};
