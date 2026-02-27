/* tenant-bootstrap.js
   Minimal visitor-side bootstrap:
   - Detect slug from URL path or ?slug=
   - Call get-tenant public endpoint: /.netlify/functions/get-tenant?slug=<slug>
   - Expose window.TENANT_ID and window.TENANT_PUBLIC
   - Dispatch event 'tenant.public.loaded'
   Note: DO NOT PUT MASTER KEY HERE. Admin reads must use server-side keys.
*/
(function () {
  'use strict';
  function getSlugFromUrl() {
    try {
      var path = (location.pathname || '/').replace(/\/+$/,'');
      var parts = path.split('/').filter(Boolean);
      if (parts.length) return parts[0];
      var p = new URLSearchParams(location.search);
      return p.get('slug') || null;
    } catch (e) { return null; }
  }
  function safeParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  async function fetchPublic(slug) {
    var url = '/.netlify/functions/get-tenant?slug=' + encodeURIComponent(slug);
    try {
      var r = await fetch(url, { method: 'GET', headers: { 'Content-Type':'application/json' } });
      var txt = await r.text();
      var data = safeParseJson(txt);
      return { ok: r.ok, status: r.status, data: data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }
  (async function bootstrap() {
    var slug = getSlugFromUrl();
    window.TENANT_ID = null;
    window.TENANT_PUBLIC = null;
    if (!slug) return;
    var res = await fetchPublic(slug);
    if (res.ok && res.data && res.data.public) {
      window.TENANT_ID = res.data.tenantId || slug;
      window.TENANT_PUBLIC = res.data.public;
      window.dispatchEvent(new CustomEvent('tenant.public.loaded', { detail: { tenantId: window.TENANT_ID, public: window.TENANT_PUBLIC } }));
      // apply minimal theme: title and css var if present
      try {
        if (window.TENANT_PUBLIC.displayName) document.title = window.TENANT_PUBLIC.displayName;
        if (window.TENANT_PUBLIC.theme && window.TENANT_PUBLIC.theme.color) {
          document.documentElement.style.setProperty('--tenant-theme-color', window.TENANT_PUBLIC.theme.color);
          var meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute('content', window.TENANT_PUBLIC.theme.color);
        }
      } catch (e) { /* ignore */ }
    } else {
      // ignore errors; pages can still function with fallback
      console.warn('tenant-bootstrap: failed to load public config', res);
    }
  })();
})();
