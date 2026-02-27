/*
 tenant-firebase.js - minimal helper for tenant-aware client usage
 - Exposes a simple API to read tenant-scoped REST paths or to hold tenantId for other scripts.
 - This file intentionally does NOT embed sensitive keys.
*/
(function () {
  window.TenantClient = {
    TENANT_ID: null,
    setTenantId: function (id) { this.TENANT_ID = id; },
    // helper to build RTDB REST path (if you want to use REST)
    rtdbPath: function (path) {
      if (!this.TENANT_ID) throw new Error('TenantClient: TENANT_ID not set');
      // ensure leading slash
      return '/tenants/' + encodeURIComponent(this.TENANT_ID) + (path ? '/' + path.replace(/^\/+/, '') : '');
    },
    // helper fetch wrapper for tenant-scoped paths through Netlify functions
    // expects you have a function that proxies reads if needed; fallback to get-tenant usage elsewhere
    fetchTenantJson: function (subpath) {
      var url = this.rtdbPath(subpath) + '.json'; // only if exposing RTDB via REST (not recommended in prod)
      return fetch(url).then(r => r.json());
    }
  };

  // auto-hook: when tenant.public.loaded fires, set TenantClient.TENANT_ID
  window.addEventListener('tenant.public.loaded', function (e) {
    if (e && e.detail && e.detail.tenantId) {
      window.TenantClient.setTenantId(e.detail.tenantId);
    }
  });
})();
