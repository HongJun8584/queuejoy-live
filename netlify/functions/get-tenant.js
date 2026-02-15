/**
 * netlify/functions/get-tenant.js
 * Returns { slug } by inspecting the Host header.
 * For dynamic control, set TENANT_HOST_MAP as a JSON env var.
 */
exports.handler = async (event) => {
  const host = (event.headers && event.headers.host) || '';
  // optional: read mapping from env (JSON string). fallback to hard-coded map.
  let hostMap = {};
  try {
    if (process.env.TENANT_HOST_MAP) hostMap = JSON.parse(process.env.TENANT_HOST_MAP);
  } catch (e) {
    // ignore parse errors; fall back to builtin map
  }

  const builtin = {
    "veli.beautiful": "veli",
    "queuejoy-live.netlify.app": "veli",
    "www.queuejoy-live.netlify.app": "veli"
  };

  const map = Object.keys(hostMap).length ? hostMap : builtin;
  const slug = map[host] || null;

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug })
  };
};
