/*
 * Example Netlify function: get-firebase-config
 * - Expects query param ?slug=your-tenant-slug
 * - Replace lookupTenantConfig() with your DB logic.
 */
exports.handler = async function (event) {
  try {
    const slug = (event.queryStringParameters && event.queryStringParameters.slug) || '';
    if (!slug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'missing slug' }) };
    }

    // TODO: Replace with your real DB lookup (admin SDK or secure HTTP to realtime DB / firestore)
    const tenantConfig = await lookupTenantConfig(slug);

    if (!tenantConfig) {
      return { statusCode: 404, body: JSON.stringify({ error: 'tenant not found' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firebaseClientConfig: tenantConfig.firebaseClientConfig })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};

async function lookupTenantConfig(slug) {
  // Example stub: for known debug slug return a demo config.
  if (slug === 'debug-tenant-2') {
    return {
      firebaseClientConfig: {
        apiKey: 'demo',
        authDomain: 'demo.firebaseapp.com',
        databaseURL: 'https://demo.firebaseio.com'
      }
    };
  }
  // Real implementation: use process.env.FIREBASE_DB_URL and admin SDK or HTTP calls.
  return null;
}
