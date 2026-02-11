/* tenant-firebase.js
 *
 * Client-side tenant helper. Drop in tenant-template/public/.
 *
 * Behavior:
 * - Auto-detect tenant slug:
 *    1) window.__TENANT__ (if hosting injects it)
 *    2) first path segment (e.g. /icecream/index.html -> slug=icecream)
 *    3) ?slug=icecream
 * - Try to fetch tenant firebase config from /.netlify/functions/get-firebase-config?slug=...
 * - If found: initialize firebase for tenant and expose window.TenantFirebase helpers:
 *      TenantFirebase.getDb(), .ref(path), .onValue(ref, cb), .get(ref)
 * - If not found: expose safe no-op helpers and a "demo mode" message.
 *
 * IMPORTANT:
 * - You must include this script BEFORE other firebase using scripts for auto-init/patching.
 * - If your pages already call initializeApp(firebaseConfig) (hardcoded), migration (above) is the safer path.
 */

(function () {
  // small helpers
  function log(...args) { console.info('[TenantFirebase]', ...args); }
  function warn(...args) { console.warn('[TenantFirebase]', ...args); }
  function err(...args) { console.error('[TenantFirebase]', ...args); }

  // detect tenant slug --- same detection logic I used in admin.html earlier
  function inferTenantSlug() {
    try {
      if (window.__TENANT__ && window.__TENANT__.slug) return window.__TENANT__.slug;
      const parts = (location.pathname || '/').split('/').filter(Boolean);
      if (parts.length && /^[a-z0-9\-]+$/.test(parts[0])) return parts[0];
      const qp = new URLSearchParams(location.search);
      if (qp.has('slug')) return qp.get('slug');
    } catch (e) {}
    return null;
  }

  const SLUG = inferTenantSlug() || (window.__TENANT__ && window.__TENANT__.slug) || null;

  // Expose basic TenantFirebase API early so other scripts can read it synchronously
  window.TenantFirebase = {
    slug: SLUG,
    mode: 'init', // 'init' | 'tenant' | 'demo' | 'error'
    firebaseConfig: null,
    db: null,
    storage: null,
    ready: false,
    // helpers (filled later)
    getDb: () => window.TenantFirebase.db,
    ref: (p) => { throw new Error('TenantFirebase not ready'); },
    onValue: () => { throw new Error('TenantFirebase not ready'); },
    get: () => { throw new Error('TenantFirebase not ready'); },
    set: () => { throw new Error('TenantFirebase not ready'); },
    patchModularRef: null, // function to attempt patching modular refs (best-effort)
  };

  async function fetchTenantConfig(slug) {
    if (!slug) return null;
    try {
      const url = `/.netlify/functions/get-firebase-config?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        warn('get-firebase-config returned', res.status);
        return null;
      }
      const j = await res.json();
      return j && typeof j === 'object' ? j : null;
    } catch (e) {
      warn('fetchTenantConfig error', e);
      return null;
    }
  }

  async function initTenant() {
    if (!SLUG) {
      warn('No tenant slug found; TenantFirebase will run in demo/read-only mode.');
      window.TenantFirebase.mode = 'demo';
      window.TenantFirebase.ready = true;
      setupNoopHelpers();
      return;
    }

    // If hosting injects firebase config via window.__TENANT__.firebaseConfig prefer that
    if (window.__TENANT__ && window.__TENANT__.firebaseConfig) {
      window.TenantFirebase.firebaseConfig = window.__TENANT__.firebaseConfig;
    } else {
      // otherwise try serverless endpoint
      const cfg = await fetchTenantConfig(SLUG);
      if (cfg) window.TenantFirebase.firebaseConfig = cfg;
    }

    if (!window.TenantFirebase.firebaseConfig) {
      warn('Firebase config not found for tenant:', SLUG);
      window.TenantFirebase.mode = 'demo';
      window.TenantFirebase.ready = true;
      setupNoopHelpers();
      return;
    }

    // dynamic imports of Firebase modular SDK
    try {
      const modApp = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
      const modDB = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js');
      const modStorage = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js');

      // initialize
      const app = modApp.initializeApp(window.TenantFirebase.firebaseConfig);
      const db = modDB.getDatabase(app);
      const storage = modStorage.getStorage(app);

      // tenantRef helper — scope everything under tenants/<slug> for safety
      const tenantRef = (rel = '') => {
        rel = String(rel || '').replace(/^\/+/, '');
        if (!rel) return modDB.ref(db, `tenants/${SLUG}`);
        return modDB.ref(db, `tenants/${SLUG}/${rel}`);
      };

      // wire helpers
      window.TenantFirebase.db = db;
      window.TenantFirebase.storage = storage;
      window.TenantFirebase.mode = 'tenant';
      window.TenantFirebase.ready = true;
      window.TenantFirebase.getDb = () => db;
      window.TenantFirebase.ref = tenantRef;
      window.TenantFirebase.onValue = (r, cb, errCb) => modDB.onValue(r, cb, errCb);
      window.TenantFirebase.get = (r) => modDB.get(r);
      window.TenantFirebase.set = (r, v) => modDB.set(r, v);
      window.TenantFirebase.push = (r, v) => modDB.push(r, v);
      window.TenantFirebase.update = (r, v) => modDB.update(r, v);
      window.TenantFirebase.remove = (r) => modDB.remove(r);
      window.TenantFirebase._mod = { modDB, modApp, modStorage };

      log('Tenant Firebase initialized for', SLUG);
    } catch (e) {
      err('Failed to init Firebase for tenant:', e);
      window.TenantFirebase.mode = 'error';
      window.TenantFirebase.ready = false;
      setupNoopHelpers();
      return;
    }
  }

  function setupNoopHelpers() {
    // safe no-op helpers to avoid runtime errors in pages when tenant config missing
    window.TenantFirebase.ref = (p) => {
      return { _noFirebase: true, _path: `tenants/${SLUG || 'template'}/${p}` };
    };
    window.TenantFirebase.onValue = (r, cb) => { warn('TenantFirebase.onValue noop for', r); };
    window.TenantFirebase.get = async (r) => ({ exists: () => false });
    window.TenantFirebase.set = async () => { throw new Error('TenantFirebase: write disabled in demo mode'); };
    window.TenantFirebase.push = async () => { throw new Error('TenantFirebase: write disabled in demo mode'); };
    window.TenantFirebase.update = async () => { throw new Error('TenantFirebase: write disabled in demo mode'); };
    window.TenantFirebase.remove = async () => { throw new Error('TenantFirebase: write disabled in demo mode'); };
    window.TenantFirebase.ready = true;
  }

  // Best-effort function to patch modular "ref" behavior in pages that import modular SDK AFTER this script runs:
  // It wraps the modular ref() returned from firebase-database module so that when code does ref(db, 'queue/...')
  // we instead return ref(db, 'tenants/<slug>/queue/...').
  //
  // Limitation: if pages imported the modular functions earlier and captured references, patching may not affect them.
  // This is "best-effort" and will be effective when this script is loaded BEFORE their imports (recommended).
  window.TenantFirebase.patchModularRef = async function patchModularRef() {
    if (!window.TenantFirebase.ready || window.TenantFirebase.mode !== 'tenant') {
      warn('patchModularRef: tenant firebase not ready or not tenant mode');
      return false;
    }
    try {
      const { modDB } = window.TenantFirebase._mod;
      if (!modDB || !modDB.ref) {
        warn('patchModularRef: modular DB not present');
        return false;
      }

      // keep original
      if (modDB.__original_ref_wrapped) {
        log('patchModularRef: already wrapped');
        return true;
      }

      const originalRef = modDB.ref.bind(modDB);
      // override ref function in the module object (this will only affect code that calls modDB.ref after this patch,
      // and may not touch local `ref` imports captured by other modules — but it's still helpful).
      modDB.ref = function (dbInstance, path) {
        // if called as ref(db, path) or ref(tenantPath) we translate
        if (typeof path === 'string' && path && !path.startsWith('tenants/')) {
          path = `tenants/${SLUG}/${path.replace(/^\/+/, '')}`;
        }
        return originalRef(dbInstance, path);
      };
      modDB.__original_ref_wrapped = true;
      log('patchModularRef: wrapped modular ref() to prefix tenants/' + SLUG);
      return true;
    } catch (e) {
      warn('patchModularRef failed', e);
      return false;
    }
  };

  // run initialization now
  (async () => {
    await initTenant();

    // If tenant initialized successfully, we attempt to patch modular ref immediately (best-effort).
    if (window.TenantFirebase.mode === 'tenant') {
      try { await window.TenantFirebase.patchModularRef(); } catch (e) { /* ignore */ }
    }

    // reveal status on global flag
    window.__TENANT_LOADED__ = { slug: SLUG, mode: window.TenantFirebase.mode, ready: window.TenantFirebase.ready };

    // last: log clear message
    if (window.TenantFirebase.mode === 'tenant') {
      log(`TenantFirebase ready for "${SLUG}". Use TenantFirebase.ref('queue/...') or TenantFirebase.getDb()`);
    } else if (window.TenantFirebase.mode === 'demo') {
      warn('TenantFirebase running in demo/read-only mode (no firebase config found for tenant).');
    } else {
      warn('TenantFirebase not ready (error). check console.');
    }

  })();

})();
