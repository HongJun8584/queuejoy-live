/*
Return firebase config for front-end consumption.

Behavior:
- If MASTER_API_KEY is set in env, this endpoint will require it (x-master-key or master_key).
- If MASTER_API_KEY is NOT set, return a safe fallback so public demo (template) works.
- If MASTER_API_KEY is set but the key is wrong, return a limited fallback with "unauthorized": true
*/
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Content-Type': 'application/json'
  };
  try {
    const qs = event.queryStringParameters || {};
    const incomingKey = qs.master_key || (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) || null;
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;

    if (MASTER_KEY) {
      if (incomingKey !== MASTER_KEY) {
        // Instead of 401, return limited fallback so demo pages can render without full access.
        const fallback = {
          apiKey: null,
          authDomain: null,
          databaseURL: null,
          projectId: null,
          unauthorized: true,
          message: 'master key invalid; requesting client is unauthorized to receive full firebase config'
        };
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, config: fallback }) };
      }
    }

    if (process.env.FIREBASE_CONFIG) {
      try {
        const cfg = JSON.parse(process.env.FIREBASE_CONFIG);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, config: cfg }) };
      } catch (_) {
        // continue
      }
    }
    const fallback = {
      apiKey: process.env.FIREBASE_API_KEY || null,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
      databaseURL: process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || null,
      projectId: process.env.FIREBASE_PROJECT_ID || null,
      note: 'This is a limited fallback, set FIREBASE_CONFIG or FIREBASE_SERVICE_ACCOUNT envs for full functionality'
    };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, config: fallback }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'internal error' }) };
  }
};
