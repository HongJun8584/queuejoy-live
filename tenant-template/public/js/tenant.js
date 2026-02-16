/* tenant.js - robust slug extractor */
export function getTenantFromLocation(location = window.location) {
  const host = location.hostname;
  const path = decodeURIComponent(location.pathname || '/');

  // debug override via query param
  try {
    const qp = new URL(location.href).searchParams;
    if (qp.get('debug_tenant')) return qp.get('debug_tenant');
  } catch (e) {}

  // /tenants/<slug>
  let m = path.match(/^\/tenants\/([^\/]+)(\/|$)/);
  if (m) return m[1];

  // root-style /<slug>
  m = path.match(/^\/([^\/]+)(\/|$)/);
  if (m) {
    const candidate = m[1].toLowerCase();
    const blacklist = ['index.html','admin','game','counter','status','404','assets','css','js','tenant-template'];
    if (!blacklist.includes(candidate)) return candidate;
  }

  // subdomain <slug>.example.netlify.app
  const hostParts = host.split('.');
  if (hostParts.length >= 3) return hostParts[0];

  return null;
}
