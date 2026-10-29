export function createSessionTracker({ staleMs = 120000, clock = Date.now } = {}) {
  const sessions = new Map();
  const startedAt = new Date(clock()).toISOString();
  let seenAt = 0;
  let emptySince = null;
  let closedAt = 0;

  function prune() {
    const now = clock();
    let lastRemoved = 0;
    for (const [id, lastSeen] of sessions) {
      if (now - lastSeen > staleMs) {
        sessions.delete(id);
        lastRemoved = Math.max(lastRemoved, lastSeen + staleMs);
      }
    }
    if (!sessions.size) emptySince ??= lastRemoved || now;
  }

  function status() {
    prune();
    if (sessions.size) emptySince = null;
    return {
      count: sessions.size,
      seen: seenAt > 0,
      idleMs: sessions.size ? 0 : clock() - (emptySince ?? clock()),
      staleMs,
      lastSeenAt: seenAt ? new Date(seenAt).toISOString() : null,
      startedAt,
      closedAt,
    };
  }

  function touch(id) {
    const key = String(id || "").trim();
    if (key) {
      sessions.set(key, clock());
      seenAt = clock();
      emptySince = null;
    }
    return status();
  }

  function close(id) {
    const key = String(id || "").trim();
    if (key) {
      sessions.delete(key);
      closedAt = clock();
    }
    if (!sessions.size) emptySince ??= clock();
    return status();
  }

  return { touch, close, status };
}
