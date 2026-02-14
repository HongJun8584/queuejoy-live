/*
Provision-site acts as a guarded wrapper: it will call createNetlifySite only if ENABLE_NETLIFY_CREATE=true.
Otherwise it returns a queued/disabled response.
*/
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
    'Content-Type': 'application/json'
  };
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
    const body = event.body ? JSON.parse(event.body) : {};
    const slug = body.slug || body.tenantId;
    if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing slug' }) };

    const enabled = String(process.env.ENABLE_NETLIFY_CREATE || 'false').toLowerCase() === 'true';
    if (!enabled) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'netlify creation is disabled in this environment' }) };
    }

    // If enabled, gracefully forward to createNetlifySite function if present.
    // This avoids duplicating netlify call logic here; we call the function HTTP endpoint.
    const siteHost = (process.env.SITE_BASE || '').replace(/\/$/, '') || null;
    // Note: you may instead import and invoke local createNetlifySite module, but invoking via HTTP keeps env separation.
    const resp = await fetch((process.env.SITE_BASE || '') + '/.netlify/functions/createNetlifySite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-master-key': process.env.MASTER_API_KEY || process.env.MASTER_KEY || '' },
      body: JSON.stringify(body)
    }).then(r => r.text()).catch(e => ({ error: String(e) }));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, forwarded: true, response: resp }) };
  } catch (err) {
    console.error('provision-site error:', err && err.stack || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'internal error' }) };
  }
};
