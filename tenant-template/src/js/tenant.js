/* tenant.js - robust slug extractor */
export function getTenantFromLocation(location = window.location) {
  const host = location.hostname;
  const path = decodeURIComponent(location.pathname || '/');

  try {
    const qp = new URL(location.href).searchParams;
    if (qp.get('debug_tenant')) return qp.get('debug_tenant');
  } catch (e) {}

  let m = path.match(/^\/tenants\/([^\/]+)(\/|$)/);
  if (m) return m[1];

  m = path.match(/^\/([^\/]+)(\/|$)/);
  if (m) {
    const candidate = m[1].toLowerCase();
    const blacklist = ['index.html', 'admin', 'game', 'counter', 'status', '404', 'assets', 'css', 'js'];
    if (!blacklist.includes(candidate)) return candidate;
  }

  const hostParts = host.split('.');
  if (hostParts.length >= 3) {
    return hostParts[0];
  }

  return null;
}
