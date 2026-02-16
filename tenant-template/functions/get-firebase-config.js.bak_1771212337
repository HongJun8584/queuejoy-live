const admin = require('./lib/firebaseAdmin');
const setHeaders = (h) => ({ 'Content-Type': 'application/json', ...h });

exports.handler = async function(event) {
  try {
    const slug = (event.queryStringParameters && event.queryStringParameters.slug) || null;
    if (!slug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'missing slug' }), headers: setHeaders() };
    }

    const db = admin.firestore();
    const docRef = db.doc(`tenants/${slug}/public/config`);
    const doc = await docRef.get();
    if (!doc.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'tenant not found' }), headers: setHeaders() };
    }

    const cfg = doc.data();
    if (cfg.serviceAccount) delete cfg.serviceAccount;
    return { statusCode: 200, body: JSON.stringify(cfg), headers: setHeaders() };
  } catch (err) {
    console.error('get-firebase-config error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'internal' }), headers: setHeaders() };
  }
};
