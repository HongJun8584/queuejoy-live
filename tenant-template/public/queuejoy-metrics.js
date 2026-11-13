export const MAX_VALID_WAIT_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 0 && value < 100000000000 ? value * 1000 : value;
    return milliseconds > 0 ? milliseconds : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const number = Number(text);
      const milliseconds = number > 0 && number < 100000000000 ? number * 1000 : number;
      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof value === 'object') {
    const seconds = Number(value.seconds ?? value._seconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
      return seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

function normalizeStatus(entry) {
  const raw = String(entry?.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['cancelled', 'canceled', 'no_show', 'noshow', 'no_showed'].includes(raw) ||
      entry?.canceledAt || entry?.cancelledAt || entry?.canceledBy || entry?.noShowAt || entry?.noShow === true) return 'excluded';
  if (['waiting', 'queued', 'pending', ''].includes(raw)) return entry?.calledAt ? 'called' : 'waiting';
  if (['called', 'serving', 'in_progress', 'attending', 'completed', 'served', 'done', 'finished'].includes(raw)) return raw;
  return 'excluded';
}

/**
 * Authoritative all-time historical wait metric. Uses only explicit joinedAt and calledAt
 * values on tenant queue records; service events and cached aggregates are deliberately ignored.
 * The object key (or record queueKey/id for array input) is the de-duplication identity.
 */
export function computeAverageWait(queueRecords, now = Date.now()) {
  const source = queueRecords && typeof queueRecords === 'object' ? queueRecords : {};
  const records = Array.isArray(source)
    ? source.map((value, index) => [String(value?.queueKey || value?.queueRecordId || value?.id || index), value])
    : Object.entries(source);
  const seen = new Set();
  const validWaitsMs = [];
  const currentTime = Number(now);

  for (const [key, entry] of records) {
    if (!entry || typeof entry !== 'object') continue;
    const recordId = String(key || entry.queueKey || entry.queueRecordId || entry.id || '').trim();
    if (!recordId || seen.has(recordId)) continue;
    seen.add(recordId);

    const status = normalizeStatus(entry);
    if (!['called', 'serving', 'in_progress', 'attending', 'completed', 'served', 'done', 'finished'].includes(status)) continue;
    // Do not recover or infer either endpoint from service duration, events, or cached wait fields.
    const joinedAt = parseTimestamp(entry.joinedAt);
    const calledAt = parseTimestamp(entry.calledAt);
    if (joinedAt === null || calledAt === null) continue;
    if (!Number.isFinite(currentTime) || joinedAt > currentTime || calledAt > currentTime) continue;
    const waitMs = calledAt - joinedAt;
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > MAX_VALID_WAIT_MS) continue;
    validWaitsMs.push(waitMs);
  }

  const averageMs = validWaitsMs.length
    ? validWaitsMs.reduce((sum, waitMs) => sum + waitMs, 0) / validWaitsMs.length
    : null;
  return { averageMs, count: validWaitsMs.length, validWaitsMs };
}

export function formatAverageWait(averageMs) {
  if (averageMs === null || averageMs === undefined || averageMs === '') return '—';
  const value = Number(averageMs);
  if (!Number.isFinite(value) || value < 0) return '—';
  const minutes = Math.round((value / 60000) * 10) / 10;
  return `${Number.isInteger(minutes) ? minutes.toFixed(0) : minutes.toFixed(1)} min`;
}
