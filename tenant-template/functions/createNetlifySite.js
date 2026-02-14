/*
Safe createNetlifySite: only acts if ENABLE_NETLIFY_CREATE=true.
Otherwise returns explicit message to avoid Netlify API errors (422).
*/
exports.handler = async function(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
    const enabled = String(process.env.ENABLE_NETLIFY_CREATE || 'false').toLowerCase() === 'true';
    if (!enabled) {
      return { statusCode: 501, headers, body: JSON.stringify({ error: 'disabled', message: 'createNetlifySite is disabled in this environment' }) };
    }
    // If enabled, you should implement with Netlify API. Keep minimal to avoid malformed payloads.
    const body = JSON.parse(event.body || '{}');
    if (!process.env.NETLIFY_AUTH_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: 'missing_netlify_token' }) };
    // Implement actual Netlify create only when you fully control payload validation.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'netlify create allowed - not implemented in safe mode' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err && err.message || 'internal' }) };
  }
};
