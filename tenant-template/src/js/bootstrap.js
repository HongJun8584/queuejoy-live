/* bootstrap.js - initialize app + route */
import { getTenantFromLocation } from './tenant.js';
import { initFirebaseForTenant } from './tenant-firebase.js';
function renderStatusPage({slug, firebaseApp}) {
  document.body.innerHTML = `<div style="padding:20px;font-family:system-ui"><h1>Status for ${slug}</h1><pre id="status-debug">connected</pre></div>`;
}
function renderTenantHome({slug, firebaseApp}) {
  document.body.innerHTML = `<div style="padding:20px;font-family:system-ui"><h1>Home for ${slug}</h1></div>`;
}

(async function main() {
  console.log('PATHNAME:', window.location.pathname);
  const slug = getTenantFromLocation();
  console.log('PARSED TENANT SLUG:', slug);

  if (!slug) {
    document.documentElement.classList.add('no-tenant');
    document.body.innerHTML = `
      <div style="padding:24px;font-family:system-ui">
        <h2>Tenant not found</h2>
        <p>This site requires a tenant slug in the URL (e.g. <code>/acme-coffee/</code>).</p>
      </div>`;
    return;
  }

  window.__TENANT__ = slug;

  try {
    const firebaseApp = await initFirebaseForTenant(slug);
    if (/\/status(\/|$)/.test(window.location.pathname)) {
      renderStatusPage({slug, firebaseApp});
    } else {
      renderTenantHome({slug, firebaseApp});
    }
  } catch (err) {
    console.error('Bootstrap error:', err);
    document.body.innerHTML = `<pre style="color:red;padding:24px">${String(err)}</pre>`;
  }
})();
