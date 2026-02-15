/* tenant-firebase.js - fetch public firebase config from serverless function */
export async function initFirebaseForTenant(slug) {
  const q = encodeURIComponent(slug);
  const res = await fetch(`/.netlify/functions/get-firebase-config?slug=${q}`);
  if (!res.ok) {
    const txt = await res.text().catch(()=>null);
    throw new Error(`Failed to get firebase config for ${slug}: ${res.status} ${txt || ''}`);
  }
  const config = await res.json();

  // Client-side init placeholder (replace with real Firebase initialization)
  if (!window.firebaseApp) {
    window.firebaseApp = { __fakeInit: true, config };
    console.log('Initialized fake firebase app for', slug, config);
  }
  return window.firebaseApp;
}
