// --- tenant-firebase production-ready loader ---
// Assumes `SLUG` is defined earlier (string). Does NOT hardcode production DB.
// Safe: validates server response, does NOT fallback to shared production DB unless explicit safe fallback is provided.

(async function tenantFirebaseLoader() {
  const TRACE = false; // set true temporarily if you need verbose console during debug (do NOT leave true in production)
  const FUNC_ENDPOINT = '/.netlify/functions/get-firebase-config';

  // Utility: fetch with timeout + small retry
  async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, ...opts });
      clearTimeout(id);
      return res;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  }

  // Try to use an existing fetchTenantConfig(SLUG) if app already provides it (backwards compatible).
  async function getTenantConfigFromApp(slug) {
    try {
      if (typeof window.fetchTenantConfig === 'function') {
        const maybe = await window.fetchTenantConfig(slug);
        if (maybe && typeof maybe === 'object') return maybe;
      }
    } catch (e) {
      if (TRACE) console.warn('fetchTenantConfig(app) failed', e && e.message);
    }
    return null;
  }

  // Primary: call serverless endpoint
  async function getTenantConfigFromServer(slug) {
    const url = `${FUNC_ENDPOINT}?slug=${encodeURIComponent(slug)}`;
    // try a couple times before giving up
    const attempts = 2;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit' }, 6000);
        if (!res.ok) {
          // Non-2xx is not fatal here; bubble up for caller to decide
          const txt = await res.text().catch(()=>null);
          throw new Error(`http ${res.status} ${txt || res.statusText}`);
        }
        const json = await res.json();
        return json;
      } catch (err) {
        if (i < attempts - 1) {
          // exponential backoff small
          await new Promise(r => setTimeout(r, 120 * Math.pow(2, i)));
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  // Validate server response shape - MUST include tenantId and a firebaseConfig object with projectId
  function validateTenantConfig(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!obj.tenantId || typeof obj.tenantId !== 'string') return false;
    if (!obj.firebaseConfig || typeof obj.firebaseConfig !== 'object') return false;
    // basic firebase keys check (client-safe fields)
    const fc = obj.firebaseConfig;
    if (!fc.projectId) return false;
    // apiKey/authDomain/databaseURL are optional depending on your client usage, but projectId is required
    return true;
  }

  // Safe initializer - does not init if invalid
  async function initTenantFirebaseSafe(slug) {
    try {
      // 1) Try app-provided loader first
      let cfg = await getTenantConfigFromApp(slug);
      if (!cfg) {
        // 2) Fallback to server endpoint
        try { cfg = await getTenantConfigFromServer(slug); } catch (e) {
          console.warn('get-firebase-config failed:', e && e.message);
          cfg = null;
        }
      }

      if (!validateTenantConfig(cfg)) {
        // No valid tenant config returned.
        // OPTION: use an explicit, deliberately injected fallback object if you set it in HTML at build time:
        // window.__GLOBAL_SAFE_FALLBACK_FIREBASE__ = { firebaseConfig: {...}, tenantId: 'demo', safeFallback: true }
        const fallback = (window && window.__GLOBAL_SAFE_FALLBACK_FIREBASE__) || null;
        if (fallback && fallback.safeFallback && validateTenantConfig({ tenantId: fallback.tenantId, firebaseConfig: fallback.firebaseConfig })) {
          // developer explicitly opted-in to a safe fallback
          window.TenantFirebase = window.TenantFirebase || {};
          window.TenantFirebase.firebaseConfig = fallback.firebaseConfig;
          window.TenantFirebase.tenantId = fallback.tenantId;
          window.__TENANT_LOADED__ = { mode: 'fallback', ready: true, slug, tenantId: fallback.tenantId };
          console.warn('Tenant loader: using explicit safe fallback config for slug:', slug);
          return true;
        }

        // Otherwise, fail safe: do NOT initialize shared production DB; mark demo mode.
        window.__TENANT_LOADED__ = { mode: 'demo', ready: false, slug: slug || null };
        console.warn('Tenant loader: no valid tenant config found for slug=', slug, ' — entering demo/no-init mode.');
        return false;
      }

      // Passed validation — commit to global
      window.TenantFirebase = window.TenantFirebase || {};
      window.TenantFirebase.firebaseConfig = cfg.firebaseConfig;
      window.TenantFirebase.tenantId = cfg.tenantId;
      // optional public client config that contains safe UI settings (no owner email)
      if (cfg.publicConfig) window.TenantFirebase.publicConfig = cfg.publicConfig;

      // Mark loaded so other scripts know tenant mode
      window.__TENANT_LOADED__ = { mode: 'tenant', ready: true, slug, tenantId: cfg.tenantId };

      // Initialize firebase client if available and not already initialized
      try {
        if (typeof window.firebase !== 'undefined') {
          if (!firebase.apps || firebase.apps.length === 0) {
            firebase.initializeApp(cfg.firebaseConfig);
            if (TRACE) console.log('Firebase client initialized for tenant', cfg.tenantId);
          } else {
            if (TRACE) console.log('Firebase client already initialized; skipping init');
          }
        } else {
          if (TRACE) console.log('firebase client not present on page; Tenant config available at window.TenantFirebase');
        }
      } catch (initErr) {
        console.error('Tenant firebase init failed:', initErr && initErr.message);
        // keep window.TenantFirebase available but mark ready false
        window.__TENANT_LOADED__ = { mode: 'tenant', ready: false, slug, tenantId: cfg.tenantId, error: String(initErr && initErr.message) };
        return false;
      }

      // IMPORTANT: enforce client-side usage convention by exposing helper for constructing tenant-scoped DB/paths
      window.TenantFirebase.path = function(pathSuffix) {
        const tid = window.TenantFirebase && window.TenantFirebase.tenantId;
        if (!tid) throw new Error('TenantFirebase: tenantId missing');
        // normalize suffix
        const s = (pathSuffix || '').replace(/^\/+/, '');
        return `tenants/${tid}/${s}`;
      };

      return true;
    } catch (err) {
      console.error('initTenantFirebaseSafe unexpected error:', err && err.message);
      window.__TENANT_LOADED__ = { mode: 'error', ready: false, slug: slug || null, error: String(err && err.message) };
      return false;
    }
  }

  // Run loader (assumes SLUG is defined)
  if (typeof SLUG === 'undefined' || !SLUG) {
    console.warn('tenant loader: SLUG not defined — skipping tenant init');
    window.__TENANT_LOADED__ = { mode: 'no-slug', ready: false };
    return;
  }

  // Execute
  await initTenantFirebaseSafe(SLUG);

  // Guidance note (non-functional): ALWAYS use window.TenantFirebase.path('...') when reading/writing DB.
  // Example:
  //   const dbRef = firebase.database().ref(window.TenantFirebase.path('meta'));
  // This ensures all reads/writes go under tenants/{tenantId}/...
})();