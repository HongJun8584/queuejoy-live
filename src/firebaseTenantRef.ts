/**
 * src/firebaseTenantRef.ts
 *
 * Small wrapper to get DB refs under tenants/{slug}/...
 * Usage:
 *   import { tenantRef } from './firebaseTenantRef';
 *   tenantRef('counters').push(...);
 *
 * NOTE: This file assumes your project uses the "firebase" namespace import
 * like: import firebase from 'firebase/app'; import 'firebase/database';
 * If you use modular SDK (v9), adjust the implementation accordingly.
 */
import firebase from 'firebase/app';
import 'firebase/database';

export function tenantBase() {
  const slug = (window as any).__TENANT_SLUG__ || 'demo';
  return `tenants/${slug}`;
}

export function tenantRef(path = '') {
  const p = path.replace(/^\/+/, '');
  const base = tenantBase();
  if (!p) return firebase.database().ref(base);
  return firebase.database().ref(`${base}/${p}`);
}
