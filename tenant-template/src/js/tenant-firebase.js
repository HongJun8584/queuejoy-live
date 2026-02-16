/* tenant-firebase.js - fetch public firebase config from serverless function */
export async function initFirebaseForTenant(slug) {
  const q = encodeURIComponent(slug);
  const res = await fetch(`/.netlify/functions/get-firebase-config?slug=${q}`);
  if (!res.ok) {
    const txt = await res.text().catch(()=>null);
    throw new Error(`Failed to get firebase config for ${slug}: ${res.status} ${txt || ''}`);
  }
  const cfg = await res.json();
  // Replace this placeholder with actual Firebase client init if using Firebase SDK:
  // import { initializeApp } from 'firebase/app'; window.firebaseApp = initializeApp(cfg);
  return cfg;
}
