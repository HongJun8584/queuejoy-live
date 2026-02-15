/**
 * src/tenant.ts
 * Resolves tenant slug using:
 *  1) Hostname via Netlify function '/.netlify/functions/get-tenant'
 *  2) Path-based fallback (first path segment)
 *  3) 'demo' final fallback
 *
 * Exposes:
 *  window.__TENANT_PROMISE__ => Promise that resolves after slug is set
 *  window.__TENANT_SLUG__    => final slug string
 */
declare global {
  interface Window {
    __TENANT_PROMISE__?: Promise<void>;
    __TENANT_SLUG__?: string;
  }
}

window.__TENANT_PROMISE__ = (async function() {
  async function hostResolve() {
    try {
      const res = await fetch('/.netlify/functions/get-tenant');
      if (res.ok) {
        const json = await res.json();
        if (json && json.slug) {
          window.__TENANT_SLUG__ = json.slug;
          return true;
        }
      }
    } catch (e) {
      // ignore network errors
    }
    return false;
  }

  const ok = await hostResolve();
  if (ok) return;

  // Path fallback
  try {
    const parts = window.location.pathname.replace(/^\/|\/$/g,'').split('/');
    if (parts[0]) {
      window.__TENANT_SLUG__ = parts[0];
      return;
    }
  } catch (e) { /* ignore */ }

  // final fallback
  window.__TENANT_SLUG__ = 'demo';
})();
export {}; // keep TS happy
