// netlify/functions/createNetlifySite.js
// Requires Node 18+ (global fetch)
exports.handler = async function handler(event) {
  try {
    // CORS / OPTIONS
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
          'Access-Control-Allow-Methods': 'POST,OPTIONS'
        }
      };
    }
    if (event.httpMethod !== 'POST') {
      return jsonResp(405, { error: 'method_not_allowed', message: 'Only POST allowed' });
    }

    // --- simple auth: MASTER key in header x-master-key or Authorization: Bearer <MASTER> ---
    const headers = {};
    for (const k of Object.keys(event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
    const MASTER = process.env.MASTER_API_KEY || process.env.MASTER_KEY;
    if (!MASTER) return jsonResp(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY missing on function' });

    let got = (headers['x-master-key'] || headers['authorization'] || '').toString();
    if (!got) return jsonResp(403, { error: 'unauthorized', message: 'missing master key' });
    if (got.startsWith('Bearer ')) got = got.slice(7);
    if (got !== MASTER) return jsonResp(403, { error: 'unauthorized', message: 'invalid master key' });

    // --- parse body ---
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { return jsonResp(400, { error: 'invalid_json', message: 'Request body must be JSON' }); }

    // required fields
    const slug = (body.slug || body.tenantId || body.name || '').toString().trim();
    if (!slug) return jsonResp(400, { error: 'invalid_request', message: 'slug (tenant id) required' });

    // repo info: fall back to env variables if not supplied in body
    const repoOwner = body.repoOwner || process.env.GITHUB_OWNER;
    const repoName = body.repoName || process.env.GITHUB_REPO;
    const branch = body.branch || process.env.GITHUB_BRANCH || 'main';
    if (!repoOwner || !repoName) {
      return jsonResp(400, { error: 'missing_repo_info', message: 'GITHUB_OWNER and GITHUB_REPO must be set in env or passed in body' });
    }

    // Netlify auth
    const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
    if (!NETLIFY_TOKEN) return jsonResp(500, { error: 'server_misconfigured', message: 'NETLIFY_AUTH_TOKEN missing on server' });

    // build an env object for the new Netlify site (merge function env defaults with body.env)
    const defaultEnv = {
      TENANT_ID: slug,
      FIREBASE_PATH: `tenants/${slug}`,
      SITE_BASE: (process.env.SITE_BASE || '').replace(/\/$/, '') || null // optional
    };
    // optional: allow injecting FIREBASE_CONFIG (stringified JSON) from body or function env
    if (body.firebaseConfig) defaultEnv.FIREBASE_CONFIG = typeof body.firebaseConfig === 'string' ? body.firebaseConfig : JSON.stringify(body.firebaseConfig);
    else if (process.env.FIREBASE_CONFIG) defaultEnv.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;

    // merge any custom env provided in request (body.env) -> body.env overrides defaults
    const buildEnv = Object.assign({}, defaultEnv, (body.env && typeof body.env === 'object') ? body.env : {});

    // prepare Netlify create site payload using repo linking
    const siteName = body.siteName || `${slug}-${Math.random().toString(36).slice(2,8)}`; // ensure reasonably unique
    const payload = {
      name: siteName,
      repo: {
        provider: 'github',
        owner: repoOwner,
        repo: repoName,
        branch
      },
      // instruct Netlify to use repo's build settings and inject env for build & runtime
      build_settings: {
        // these env vars will be available to build step and runtime (window.__ENV build-time injection if you use it)
        env: buildEnv
      }
    };

    // call Netlify API
    const netlifyRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const netlifyBodyText = await netlifyRes.text();
    let netlifyBody;
    try { netlifyBody = JSON.parse(netlifyBodyText); } catch { netlifyBody = { raw: netlifyBodyText }; }

    if (!netlifyRes.ok) {
      console.error('netlify create failed', netlifyRes.status, netlifyBody);
      return jsonResp(502, { error: 'netlify_create_failed', status: netlifyRes.status, body: netlifyBody });
    }

    // success - return useful details
    const result = {
      ok: true,
      site: {
        id: netlifyBody.id,
        name: netlifyBody.name,
        url: netlifyBody.ssl_url || netlifyBody.url || null,
        admin_url: netlifyBody.admin_url || `https://app.netlify.com/sites/${netlifyBody.name}`
      },
      tenant: {
        slug
      },
      build_env: buildEnv
    };

    return jsonResp(200, result);
  } catch (err) {
    console.error('unhandled error', err && (err.stack || err.message || String(err)));
    return jsonResp(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }

  // small helper
  function jsonResp(status, body) {
    return {
      statusCode: status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      },
      body: JSON.stringify(body)
    };
  }
};
