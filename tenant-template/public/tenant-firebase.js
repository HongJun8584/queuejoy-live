// --- 开始 fallback 片段 ---
// assume SLUG is already defined earlier in this file
async function initTenantFirebase() {
  try {
    const cfg = await fetchTenantConfig(SLUG); // 原有函数
    if (cfg) {
      window.TenantFirebase = window.TenantFirebase || {};
      window.TenantFirebase.firebaseConfig = cfg;
      console.log('Tenant firebaseConfig loaded from serverless for', SLUG);
    } else {
      // FALLBACK: use project-level firebase config (temporary debug fallback)
      window.TenantFirebase = window.TenantFirebase || {};
      window.TenantFirebase.firebaseConfig = {
        // optional apiKey
        // apiKey: "<optional>",
        authDomain: "queuejoy-live.firebaseapp.com",
        databaseURL: "https://queuejoy-live.firebaseio.com",
        projectId: "queuejoy-live",
        storageBucket: "queuejoy-live.appspot.com"
      };
      console.log('Using fallback global firebaseConfig for tenant:', SLUG);
    }
    // mark ready so other scripts know tenant mode
    window.__TENANT_LOADED__ = { mode: 'tenant', ready: true, slug: SLUG };
  } catch (err) {
    console.error('tenant-firebase init error:', err);
    window.__TENANT_LOADED__ = { mode: 'demo', ready: false };
  }
}
// call it immediately
initTenantFirebase();
// --- 结束 fallback 片段 ---
