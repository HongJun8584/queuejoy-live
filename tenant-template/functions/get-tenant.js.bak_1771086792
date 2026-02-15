const admin = require('./lib/firebaseAdmin');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Content-Type': 'application/json'
  };

  try {
    const qs = event.queryStringParameters || {};
    const incomingKey = (qs.master_key || qs.masterKey || (event.headers && event.headers['x-master-key']) ) || null;
    const MASTER_KEY = process.env.MASTER_API_KEY || process.env.MASTER_KEY || null;
    if (!MASTER_KEY || incomingKey !== MASTER_KEY) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'invalid or missing master key' }) };
    }
    const slug = qs.slug;
    if (!slug) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing slug param' }) };
    }

    const db = admin.database();
    const ref = db.ref(`/tenants/${slug}`);
    const snap = await ref.once('value');
    const tenant = snap.val();
    if (!tenant) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'tenant not found' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(tenant) };
  } catch (err) {
    console.error('get-tenant error:', err && (err.stack || err.message || err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: err && err.message ? err.message : 'internal error' }) };
  }
};
