// netlify/functions/createBusiness.js
// Node 18+ runtime expected (global fetch available)

const admin = require('firebase-admin');

function jsonResponse(status, body) {
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

/* ---------- Firebase lazy init ---------- */
let initialized = false;
let initError = null;
async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) return { admin, db: admin.database() };
  if (initError) throw initError;
  try {
    const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL;
    if (!dbUrl) throw new Error('FIREBASE_DB_URL is not set.');
    const serviceAccount = parseServiceAccountFromEnv();
    if (!serviceAccount) throw new Error('Firebase service account not found.');
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

function normalizeSlug(raw = '') {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
function sanitizeName(n) { return (n || '').toString().trim(); }

/* ---------- GitHub helper (copy template tree into target folder) ---------- */
async function githubApiFetch(path, method = 'GET', body = null, token) {
  const url = `https://api.github.com${path}`;
  const opts = { method, headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'queuejoy-createbusiness' } };
  if (token) opts.headers['Authorization'] = `token ${token}`;
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { text }; }
  return { ok: res.ok, status: res.status, body: json };
}

// list files recursively then fetch content
async function listRepoFilesRecursive(owner, repo, path, branch, token) {
  const out = [];
  async function walk(p) {
    const apiPath = `/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(branch)}`;
    const r = await githubApiFetch(apiPath, 'GET', null, token);
    if (!r.ok) return;
    const items = r.body;
    if (!Array.isArray(items)) {
      if (items && items.type === 'file') {
        out.push({ path: items.path, sha: items.sha });
      }
      return;
    }
    for (const it of items) {
      if (it.type === 'file') out.push({ path: it.path, sha: it.sha });
      else if (it.type === 'dir') await walk(it.path);
    }
  }
  await walk(path);
  for (const f of out) {
    const r = await githubApiFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`, 'GET', null, token);
    if (r.ok && r.body && r.body.content) { f.content = r.body.content; f.encoding = r.body.encoding; } else { f.content = null; f.encoding = null; }
  }
  return out;
}

async function deployTenantToRepo(slug, options = {}) {
  const {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main',
    TEMPLATE_PATH_IN_REPO = 'template', TARGET_BASE_PATH = slug, COMMITTER = null
  } = options;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('Missing GitHub deployment env (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)');
  }
  const templatePath = TEMPLATE_PATH_IN_REPO.replace(/^\/+|\/+$/g, '') || 'template';
  const files = await listRepoFilesRecursive(GITHUB_OWNER, GITHUB_REPO, templatePath, GITHUB_BRANCH, GITHUB_TOKEN);
  if (!files || files.length === 0) throw new Error(`Template path "${templatePath}" is empty or not found in repo`);
  const created = [];
  for (const f of files) {
    if (!f.path || !f.content) continue;
    let rel = f.path.replace(new RegExp(`^${templatePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/?`), '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    const targetPath = `${TARGET_BASE_PATH}/${rel}`;
    const message = `Create tenant ${slug} - add ${targetPath}`;
    const payload = { message, content: f.content.replace(/\n/g,''), branch: GITHUB_BRANCH };
    if (COMMITTER && COMMITTER.name && COMMITTER.email) payload.committer = { name: COMMITTER.name, email: COMMITTER.email };
    const apiPathCreate = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(targetPath)}`;
    let r = await githubApiFetch(apiPathCreate, 'PUT', payload, GITHUB_TOKEN);
    if (!r.ok && (r.status === 422 || (r.body && r.body.message && /exists/i.test(r.body.message)))) {
      const getRes = await githubApiFetch(`${apiPathCreate}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, 'GET', null, GITHUB_TOKEN);
      if (getRes.ok && getRes.body && getRes.body.sha) {
        payload.sha = getRes.body.sha;
        r = await githubApiFetch(apiPathCreate, 'PUT', payload, GITHUB_TOKEN);
      }
    }
    if (!r.ok) { created.push({ path: targetPath, ok: false, status: r.status, body: r.body }); }
    else { created.push({ path: targetPath, ok: true, url: (r.body && r.body.content && r.body.content.html_url) || null }); }
  }
  return created;
}

/* ---------- Netlify helper (create site from repo) ---------- */
async function createNetlifySiteFromRepo({ NETLIFY_AUTH_TOKEN, GITHUB_OWNER, GITHUB_REPO, branch = 'main', siteName }) {
  if (!NETLIFY_AUTH_TOKEN) throw new Error('NETLIFY_AUTH_TOKEN missing');
  // Netlify API: create site with repo object
  const url = 'https://api.netlify.com/api/v1/sites';
  const body = {
    name: siteName,
    // instruct Netlify to link to the GitHub repo
    repo: {
      provider: 'github',
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      branch
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NETLIFY_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(j));
  return j; // contains site.url, id, build_settings...
}

/* ---------- Notifications (Telegram and optional SendGrid email) ---------- */
async function notifyTelegram(token, chatId, text) {
  if (!token || !chatId) return { skipped: true, reason: 'missing token/chatId' };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const j = await res.json();
  return j;
}

async function sendEmailViaSendGrid(sendGridKey, to, subject, text) {
  if (!sendGridKey || !to) return { skipped: true };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sendGridKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.ADMIN_EMAIL || 'no-reply@yourdomain.com' },
      subject, content: [{ type: 'text/plain', value: text }]
    })
  });
  const jtext = await res.text();
  return { status: res.status, body: jtext };
}

/* ---------- Handler ---------- */
exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } };
    }
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });

    // auth: master key
    const lowHeaders = {};
    for (const k of Object.keys(event.headers || {})) lowHeaders[k.toLowerCase()] = event.headers[k];
    const master = process.env.MASTER_API_KEY || process.env.MASTER_KEY || '';
    if (!master) return jsonResponse(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY not configured on server' });
    let got = (lowHeaders['x-master-key'] || lowHeaders['x-api-key'] || lowHeaders['authorization'] || '').toString();
    if (!got) return jsonResponse(403, { error: 'unauthorized', message: 'missing master key' });
    if (got.startsWith('Bearer ')) got = got.slice(7);
    if (got !== master) return jsonResponse(403, { error: 'unauthorized', message: 'invalid master key' });

    // parse body
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' }); }

    const slug = normalizeSlug(body.slug || body.name || '');
    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug/name is required' });
    const name = sanitizeName(body.name || slug);
    const createdBy = body.createdBy || 'landing-page';
    const nowIso = new Date().toISOString();

    // Step A: Copy template into GitHub under folder <slug>/...
    const repoDeployEnabled = String(process.env.ENABLE_REPO_DEPLOY || 'false').toLowerCase() === 'true';
    let repoResult = null;
    if (repoDeployEnabled) {
      try {
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_OWNER = process.env.GITHUB_OWNER;
        const GITHUB_REPO = process.env.GITHUB_REPO;
        const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
        const TEMPLATE_PATH_IN_REPO = (process.env.TEMPLATE_PATH_IN_REPO || body.templatePath || 'template').replace(/^\/+|\/+$/g, '');
        const TARGET_BASE_PATH = slug;
        const COMMITTER = (process.env.GITHUB_COMMITTERNAME && process.env.GITHUB_COMMITTEREMAIL) ? { name: process.env.GITHUB_COMMITTERNAME, email: process.env.GITHUB_COMMITTEREMAIL } : null;
        repoResult = await deployTenantToRepo(slug, { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, TEMPLATE_PATH_IN_REPO, TARGET_BASE_PATH, COMMITTER });
      } catch (e) {
        console.error('repo deploy failed', e && (e.stack || e.message || e));
        repoResult = { error: true, message: e && e.message ? e.message : String(e) };
      }
    }

    // Step B: Create Netlify site that uses this repo path (optional)
    const netlifyEnabled = String(process.env.ENABLE_NETLIFY_CREATE || 'false').toLowerCase() === 'true';
    let netlifyResult = null;
    if (netlifyEnabled) {
      try {
        const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
        const GITHUB_OWNER = process.env.GITHUB_OWNER;
        const GITHUB_REPO = process.env.GITHUB_REPO;
        const branch = process.env.GITHUB_BRANCH || 'main';
        const siteName = `${slug}-${Math.random().toString(36).slice(2,8)}`; // ensure uniqueness
        netlifyResult = await createNetlifySiteFromRepo({ NETLIFY_AUTH_TOKEN, GITHUB_OWNER, GITHUB_REPO, branch, siteName });
      } catch (e) {
        console.error('netlify create failed', e && (e.stack || e.message || e));
        netlifyResult = { error: true, message: e && e.message ? e.message : String(e) };
      }
    }

    // Step C: Persist tenant config into Firebase (this step intended to always run)
    let db;
    try {
      const fb = await ensureFirebase();
      db = fb.db;
    } catch (initErr) {
      console.error('firebase init failed', initErr && (initErr.stack || initErr.message || initErr));
      // we continue but return error later
    }

    let firebaseWriteResult = null;
    if (db) {
      try {
        const siteBase = (process.env.SITE_BASE || '').replace(/\/$/, '');
        const tenant = {
          slug, name, createdBy, createdAt: nowIso,
          links: { home: `${siteBase}/${slug}`, counter: `${siteBase}/${slug}/counter.html`, admin: `${siteBase}/${slug}/admin.html` },
          repo: { deployed: !!repoResult, details: repoResult },
          netlify: netlifyResult,
          settings: body.settings || body.defaults || {},
        };
        await db.ref(`tenants/${slug}`).set(tenant);
        firebaseWriteResult = { ok: true };
      } catch (e) {
        console.error('firebase write failed', e && (e.stack || e.message || e));
        firebaseWriteResult = { error: true, message: e && e.message ? e.message : String(e) };
      }
    }

    // Step D: Notify user via Telegram and (optionally) email
    const notifyText = (() => {
      const base = process.env.SITE_BASE ? process.env.SITE_BASE.replace(/\/$/, '') : '';
      const siteUrl = base ? `${base}/${slug}` : (netlifyResult && netlifyResult.url ? netlifyResult.url : null);
      let t = `Your QueueJoy site is ready!\n\nName: ${name}\nSlug: ${slug}\n`;
      if (siteUrl) t += `Site: ${siteUrl}\n`;
      t += `CreatedAt: ${nowIso}\n\nVisit the admin: ${base ? `${base}/${slug}/admin.html` : '(use Netlify admin or your dashboard)'}`;
      return t;
    })();

    // Telegram: send to chat id provided in body.notifyChatId or global CHAT_ID
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    const chatId = body.notifyChatId || process.env.CHAT_ID;
    let telegramResult = null;
    if (telegramToken && chatId) {
      try { telegramResult = await notifyTelegram(telegramToken, chatId, notifyText); } catch (e) { console.error('telegram notify failed', e && e.message); telegramResult = { error: true, message: String(e) }; }
    } else {
      telegramResult = { skipped: true };
    }

    // Optional SendGrid email
    let emailResult = null;
    if (process.env.SENDGRID_API_KEY && body.notifyEmail) {
      try { emailResult = await sendEmailViaSendGrid(process.env.SENDGRID_API_KEY, body.notifyEmail, 'Your QueueJoy site is ready', notifyText); } catch (e) { console.error('sendgrid failed', e && e.message); emailResult = { error: true, message: String(e) }; }
    } else {
      emailResult = { skipped: true };
    }

    const summary = {
      ok: true, slug, name, createdAt: nowIso,
      repoDeploy: repoResult,
      netlify: netlifyResult,
      firebase: firebaseWriteResult,
      telegram: telegramResult,
      email: emailResult
    };

    return jsonResponse(200, summary);
  } catch (err) {
    console.error('unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};
