// public/firebase-config.js
// Robust client-side Firebase initializer for QueueJoy (single Firebase project, multi-tenant by path)

// NOTE:
//  - This file is safe to commit: it contains only *public* Firebase client keys.
//  - Tenant-specific config is fetched from a Netlify function when possible.
//  - The tenant bootstrapping (window.__TENANT_ID / tenant.public.loaded) is handled by tenant-firebase.js
//  - Usage: await initFirebase({ slug }); then use getApp(), getDb(), tenantDbRef(path) etc.

import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref as rtdbRef } from 'firebase/database';

// ---- DEFAULT (fallback) client config for local/demo preview ----
// Replace values below only for local demo preview. Production should rely on
// the get-firebase-config Netlify function or environment-managed builds.
const DEFAULT_CLIENT_CONFIG = {
  apiKey: "AIzaSyBYJlAo0HcnlifELg99BgLBU6U_OCnUoH8",
  authDomain: "queuejoy-live.firebaseapp.com",
  databaseURL: "https://queuejoy-live-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "queuejoy-live",
  storageBucket: "queuejoy-live.firebasestorage.app",
  messagingSenderId: "882772437195",
  appId: "1:882772437195:web:60a2f1081a139d0810d34e",
  measurementId: "G-KWBELWRC5M"
};

let _app = null;
let _db = null;
let _clientConfigUsed = null;

// ---- Helpers ----
function parseQuerySlug() {
  try {
    const q = new URLSearchParams(location.search || '');
    return q.get('slug') || null;
  } catch (e) {
    return null;
  }
}

async function fetchTenantClientConfig(slug) {
  if (!slug) return null;
  try {
    const url = `/.netlify/functions/get-firebase-config?slug=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const j = await res.json().catch(()=>null);
    if (!j) return null;
    // Function should return either { firebaseClientConfig } or a sanitized config object
    if (j.firebaseClientConfig) return j.firebaseClientConfig;
    if (j.config && j.config.firebaseClientConfig) return j.config.firebaseClientConfig;
    // Some implementations return top-level config
    if (j.firebaseConfig) return j.firebaseConfig;
    if (j.config) return j.config;
    return null;
  } catch (e) {
    // network or CORS etc
    return null;
  }
}

// Wait until tenant.public.loaded event (if tenant will be set by bootstrap)
function waitForTenantEvent(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (window.__TENANT_SLUG) return resolve(window.__TENANT_SLUG);
    let cleared = false;
    const onLoaded = (e) => {
      if (cleared) return;
      cleared = true;
      window.removeEventListener('tenant.public.loaded', onLoaded);
      resolve(e && e.detail && e.detail.slug ? e.detail.slug : null);
    };
    window.addEventListener('tenant.public.loaded', onLoaded);
    if (timeoutMs) setTimeout(() => { if (!cleared) { cleared = true; window.removeEventListener('tenant.public.loaded', onLoaded); resolve(null); } }, timeoutMs);
  });
}

// Initialize Firebase app. Tries (in order): explicit slug fetch -> window.__TENANT_SLUG -> query slug -> fallback DEFAULT_CLIENT_CONFIG
export async function initFirebase(opts = {}) {
  if (_app && getApps && getApps().length) return { app: _app, db: _db, clientConfig: _clientConfigUsed };
  const { slug: explicitSlug = null, waitForTenant = true } = opts;

  // 1) Try explicit slug
  let slug = explicitSlug || null;

  // 2) If none, prefer tenant event or existing global
  if (!slug) {
    if (typeof window !== 'undefined' && window.__TENANT_SLUG) slug = window.__TENANT_SLUG;
    else if (waitForTenant) slug = await waitForTenantEvent(2500) || null;
  }

  // 3) If still none, try URL query
  if (!slug) slug = parseQuerySlug();

  // 4) Try fetch of tenant-scoped client config
  let fetched = null;
  if (slug) {
    fetched = await fetchTenantClientConfig(slug);
  }

  const clientCfg = fetched || DEFAULT_CLIENT_CONFIG;

  // initialize
  try {
    _app = initializeApp(clientCfg);
    _db = getDatabase(_app);
    _clientConfigUsed = clientCfg;
    return { app: _app, db: _db, clientConfig: _clientConfigUsed };
  } catch (e) {
    // If initializeApp fails (rare), rethrow for caller to handle
    throw e;
  }
}

export function getApp() {
  if (!_app) throw new Error('Firebase app not initialized. Call initFirebase() first.');
  return _app;
}

export function getDb() {
  if (!_db) throw new Error('Firebase DB not initialized. Call initFirebase() first.');
  return _db;
}

// Returns a string path under tenants/{tenantId}/...
export function tenantDbPath(subpath) {
  const tid = (typeof window !== 'undefined' && (window.__TENANT_ID || (window.TenantClient && window.TenantClient.TENANT_ID))) || null;
  if (!tid) throw new Error('Tenant ID not available. Ensure tenant.public.loaded fired or set window.__TENANT_ID.');
  if (!subpath) return `tenants/${encodeURIComponent(tid)}`;
  const clean = String(subpath).replace(/^\/+/, '');
  return `tenants/${encodeURIComponent(tid)}/${clean}`;
}

// Returns a Realtime Database SDK ref for tenants/{tenantId}/{subpath}
export function tenantDbRef(subpath) {
  const db = getDb();
  const path = tenantDbPath(subpath);
  return rtdbRef(db, path);
}

// Convenience: returns the raw client config used (useful for debugging)
export function clientConfigUsed() {
  return _clientConfigUsed;
}

// Default export for convenience
export default {
  initFirebase,
  getApp,
  getDb,
  tenantDbPath,
  tenantDbRef,
  clientConfigUsed
};
