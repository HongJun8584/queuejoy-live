# QueueJoy UI/UX and integration outcomes

## Implemented

- [x] **Shared design system:** Customer, counter, admin and game pages use a consistent purple-led SaaS design system, soft neutral surfaces, readable hierarchy, shared spacing, refined cards/controls, responsive layouts, visible focus/hover feedback, reduced-motion handling and shared favicon utilities.
- [x] **Counter dashboard:** Reworked staff dashboard presentation, card hierarchy and actions while preserving queue generation, assignment, history, cancellation/reset/delete, notification templates, settings, Firebase paths and IDs. Call Next duplicate locks are per-counter; pending feedback stays local to that counter. New-counter creation is capped at four atomically across counter/admin sessions without deleting legacy records.
- [x] **Live customer display editor:** Added the landscape preview editor, visual style controls, movable/resizable blocks, save/reset/fullscreen actions, tenant branding, live queue data, optional validated video, TV-friendly rendering and mobile editor refinements. Display-specific settings save under `tenants/{tenantId}/public/config/counterDisplay`; they do not overwrite the separate `ad.video` setting.
- [x] **Admin control center:** Refined navigation, dashboard, metrics, settings and responsive styling while retaining existing Auth, tenant config, uploads, charts, analytics, announcements, audit, cleanup and account interactions. Config publication preserves unmodified tenant fields; tenant lookup now fails closed.
- [x] **Customer entry:** Refined the mobile-first business/Join Queue hierarchy, validated tenant slugs and IDs, and deferred promotion image/video/embed loading so ad media does not gate the join action.
- [x] **Customer status:** Refined ticket/progress/status presentation, retained translations and existing Telegram/ad flows, applied tenant favicon live, removed premature browser-side Telegram token consumption, made tenant lookup authoritative and changed cancellation to an atomic transaction on the exact tenant queue path.
- [x] **Called-ticket page:** Refined the mobile brand/ticket hierarchy, live tenant branding/favicon and hidden-state handling; validates the tenant link and requests a one-time Telegram URL from the backend for the exact resolved queue record.
- [x] **Game page:** Removed the advertisement bar/listeners; requires slug-resolved tenant context; searches supported tenant-only queue layouts before attaching the live listener; redirects to `your_turn.html` with queue key, slug and verified tenant ID when the record is called or its counter is serving it.
- [x] **One shared Avg Wait Time calculation:** Counter/admin use the same queue-record-only helper and all-time window. It deduplicates queue child records, accepts only valid `calledAt - joinedAt` waits for called/serving/completed records, and excludes canceled/no-show, waiting, invalid/missing/future/negative/duplicate and >24-hour records. Empty data formats as `—`. Existing Avg Service Time and ETA remain distinct.
- [x] **Tenant favicon:** Added admin URL/upload/preview/default controls and dynamic tenant-scoped favicon propagation on all five target pages without modifying business logo fields. Added a QueueJoy-owned default SVG.
- [x] **Telegram reliability/security:** Server-issued links are tied to an exact tenant queue record; server validates tenant and expiry; webhook consumption is one-time/idempotent; queue chat attachment is a Firebase transaction that prevents two different chats from racing to overwrite one queue child; successful messages are reported correctly; duplicate success confirmations are guarded; logs avoid raw tokens/chat identifiers.
- [x] **Tenant boundary hardening:** Shared `get-tenant` rejects unsafe slugs and invalid tenant IDs before path construction; status/index/admin/counter/your-turn/game clients validate business slug/tenant context and do not fall back to an unverified tenant ID.

## Verification performed

- [x] JavaScript syntax checked for inline scripts in all six pages and for changed Netlify functions.
- [x] Shared Avg Wait Time tests passed for valid, missing, canceled, waiting, future, negative, outlier and duplicate records.
- [x] Static integration assertions passed for shared styles/favicons, game ad removal/redirect, status token flow, atomic counter limits, customer ad lazy loading and tenant/cancellation guards.
- [x] `git diff --check` passed.
- [x] Opened local static previews of customer entry and counter pages. The preview used an intentionally unresolved `preview` slug and did not read or mutate production tenant data.

## Staging-only follow-up

- [ ] Run live customer joining, staff Call Next, TV display save/refresh/fullscreen/video, status cancellation, Telegram `/start` success/retry/expiry, admin config/favicon upload and concurrent counter-create checks on a staging tenant with valid Netlify Functions/Firebase configuration.
- [ ] Review/deploy Firebase RTDB Security Rules independently. No rules file was present in this repository checkout, and this implementation did not change production data or rules.
