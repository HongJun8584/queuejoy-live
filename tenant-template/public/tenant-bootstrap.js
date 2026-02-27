/*
 tenant-bootstrap.js
 - Automatically runs on every page.
 - Extracts slug from URL, fetches public tenant config, applies theme/title/logo,
   and exposes window.TENANT_ID and window.TENANT_PUBLIC for other scripts.
 - Uses get-tenant function: /.netlify/functions/get-tenant?slug=<slug>
*/

(function () {
  'use strict';

  function getSlugFromUrl() {
    // path like /slug or /slug/ or /slug/admin.html
    try {
      var path = (window.location.pathname || '/').replace(/\/+$/, '');
      var parts = path.split('/').filter(Boolean);
      if (parts.length) return parts[0];
      var params = new URLSearchParams(window.location.search);
      return params.get('slug') || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchTenantPublic(slug) {
    var url = '/.netlify/functions/get-tenant?slug=' + encodeURIComponent(slug);
    var resp = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!resp.ok) {
      // still try to parse JSON error
      var txt = await resp.text();
      try { return JSON.parse(txt); } catch(e) { throw new Error('fetch failed: ' + resp.status); }
    }
    return resp.json();
  }

  function applyPublicConfig(pub) {
    try {
      if (!pub) return;
      // set title
      if (pub.displayName) {
        document.title = pub.displayName;
        var el = document.querySelector('meta[property="og:title"],meta[name="og:title"]');
        if (el) el.setAttribute('content', pub.displayName);
      }
      // set theme color CSS variable
      if (pub.theme && pub.theme.color) {
        document.documentElement.style.setProperty('--tenant-theme-color', pub.theme.color);
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', pub.theme.color);
      }
      // set logo if found (assumes an element with id="tenant-logo" exists in your template)
      if (pub.logo) {
        var logoEl = document.getElementById('tenant-logo');
        if (logoEl) {
          logoEl.src = pub.logo;
        }
      }
    } catch (e) {
      console.warn('applyPublicConfig error', e && e.message);
    }
  }

  // bootstrap on DOMContentLoaded if necessary
  (async function bootstrap() {
    var slug = getSlugFromUrl();
    if (!slug) {
      // no slug in path; nothing to do
      window.TENANT_ID = null;
      window.TENANT_PUBLIC = null;
      return;
    }
    try {
      var data = await fetchTenantPublic(slug);
      // expected shape: { tenantId, slug, public: {...} } or error
      if (data && data.public) {
        window.TENANT_ID = data.tenantId || slug;
        window.TENANT_PUBLIC = data.public;
        applyPublicConfig(data.public);
        // dispatch event so other scripts can react
        window.dispatchEvent(new CustomEvent('tenant.public.loaded', { detail: { tenantId: window.TENANT_ID, public: window.TENANT_PUBLIC } }));
      } else {
        // if admin payload (no public), attempt to extract
        if (data && data.tenant && typeof data.tenant === 'object') {
          var pub = data.tenant.public || data.tenant.meta || {};
          window.TENANT_ID = data.tenantId || slug;
          window.TENANT_PUBLIC = pub;
          applyPublicConfig(pub);
          window.dispatchEvent(new CustomEvent('tenant.public.loaded', { detail: { tenantId: window.TENANT_ID, public: window.TENANT_PUBLIC } }));
        } else {
          console.warn('get-tenant returned unexpected', data);
        }
      }
    } catch (err) {
      console.warn('tenant-bootstrap failed to load tenant public config for slug=' + slug, err && (err.message || err));
    }
  })();

})();
