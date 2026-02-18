// tenant-template/functions/createTelegramLink.js
// Node 18+ (Netlify functions) - CommonJS
// Generates a /start token and (optionally) persists mapping to Firebase RTDB.
// Environment:
//   FIREBASE_DB_URL   - Realtime DB root URI, e.g. https://your-db.firebaseio.com
//   BOT_USERNAME      - Telegram bot username (without @), default QueueJoyBot
//   ALLOWED_ORIGIN    - CORS origin (default '*')
// Token TTL: 24 hours

const { nanoid } = require('nanoid');

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function jsonBody(status, obj, origin = '*') {
  return {
    statusCode: status,
    headers: {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    },
    body: typeof obj === 'string' ? JSON.stringify({ message: obj }) : JSON.stringify(obj)
  };
}

function sanitize(v, max = 250) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function pickTenantFromRequest(event, body) {
  // priority: body.tenant | body.slug | query ?slug= | header x-tenant
  if (body && (body.tenant || body.slug)) return sanitize(body.tenant || body.slug);
  try {
    const url = event.rawUrl || (event.path ? (event.path + (event.queryStringParameters ? '' : '')) : null);
    // fallback to event.queryStringParameters (Netlify)
    if (event.queryStringParameters && event.queryStringParameters.slug) return sanitize(event.queryStringParameters.slug);
  } catch (e) {}
  if (event.headers) {
    const low = {};
    for (const k of Object.keys(event.headers || {})) low[k.toLowerCase()] = event.headers[k];
    if (low['x-tenant']) return sanitize(low['x-tenant']);
  }
  return '';
}

exports.handler = async function handler(event) {
  const CORS_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonBody(405, { error: 'Only POST allowed' }, CORS_ORIGIN);
  }

  // parse JSON body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return jsonBody(400, { error: 'Invalid JSON body' }, CORS_ORIGIN);
  }

  // inputs
  const queueKey = sanitize(body.queueKey || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const meta = sanitize(body.meta || '');

  // decide tenant slug (optional)
  const tenantSlug = sanitize(pickTenantFromRequest(event, body) || '');

  // generate token + timestamps
  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString();

  // payload to persist to DB
  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;
  const ip = (
    (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'])) ||
    (event.headers && (event.headers['x-nf-client-connection-ip'])) || null
  );

  const payload = {
    queueKey,
    counterId,
    counterName,
    meta,
    createdAt,
    expiresAt,
    used: false,
    userAgent,
    ip
  };

  // build Telegram link (keep behavior unchanged)
  const botEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
  const botUsername = String(botEnv).replace(/^@/, '').trim() || 'QueueJoyBot';
  const telegramLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;

  // persist to Firebase RTDB if configured
  const FIREBASE_DB_URL_RAW = process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || '';
  const FIREBASE_DB_URL = String(FIREBASE_DB_URL_RAW).replace(/\/$/, ''); // remove trailing slash

  if (FIREBASE_DB_URL) {
    // choose path: /tenants/{slug}/telegramTokens/{token}.json OR /telegramTokens/{token}.json
    const tokenPathParts = tenantSlug ? [`tenants`, encodeURIComponent(tenantSlug), 'telegramTokens', encodeURIComponent(token)+'.json'] :
                                       ['telegramTokens', encodeURIComponent(token)+'.json'];
    const path = `${FIREBASE_DB_URL}/${tokenPathParts.join('/')}`;
    try {
      // use PUT to set the token node
      const resp = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const text = await resp.text().catch(()=>'');
        console.warn('createTelegramLink: firebase write failed', resp.status, text);
        // non-fatal - continue and return link
      }
    } catch (err) {
      console.warn('createTelegramLink: firebase write exception', String(err));
      // non-fatal
    }
  } else {
    // not configured - warn and continue
    console.warn('createTelegramLink: FIREBASE_DB_URL not set — token will not be persisted');
  }

  // Return successful response (always returns link even if DB write failed)
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Accept, x-tenant',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ok: true,
      link: telegramLink,
      token,
      createdAt,
      expiresAt,
      tenant: tenantSlug || null
    })
  };
};
