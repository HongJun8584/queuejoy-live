/* bootstrap.js - initialize app + route */
import { getTenantFromLocation } from './tenant.js';
import { initFirebaseForTenant } from './tenant-firebase.js';

function setDebugPath(path) {
  const debugEl = document.getElementById('tenant-debug');
  if (debugEl) debugEl.dataset.path = path;
}

(async function main() {
  console.log('PATHNAME:', window.location.pathname);
  const slug = getTenantFromLocation();
  console.log('PARSED TENANT SLUG:', slug);

  setDebugPath(window.location.pathname);

  if (!slug) {
    document.documentElement.classList.add('no-tenant');
    document.getElementById('app-root').innerHTML = '<h2>Tenant not found</h2>';
    return;
  }

  window.__TENANT__ = slug;

  try {
    const cfg = await initFirebaseForTenant(slug);
    console.log('Tenant firebase config loaded for', slug, !!(cfg && cfg.apiKey));
    // TODO: call your render functions here (e.g. renderStatusPage / renderTenantHome)
    document.getElementById('app-root').innerHTML = `<div style="padding:16px;font-family:system-ui"><h1>Tenant: ${slug}</h1><pre>${JSON.stringify(cfg,null,2)}</pre></div>`;
  } catch (err) {
    console.error('init firebase error', err && (err.stack || err));
    document.getElementById('app-root').innerHTML = `<pre style="color:red">${String(err)}</pre>`;
  }
})();
