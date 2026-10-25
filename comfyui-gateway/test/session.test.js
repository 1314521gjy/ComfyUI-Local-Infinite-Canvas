import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionTracker } from "../src/sessions.js";

test("tracks multiple canvas sessions and ignores empty ids", () => {
  const sessions = createSessionTracker({ clock: () => 1000 });
  assert.equal(sessions.status().seen, false);
  sessions.touch("");
  assert.equal(sessions.status().seen, false);
  sessions.touch("a");
  sessions.touch("b");
  assert.deepEqual(
    [sessions.status().count, sessions.status().seen],
    [2, true],
  );
  sessions.close("a");
  assert.equal(sessions.status().count, 1);
  sessions.close("b");
  assert.equal(sessions.status().count, 0);
  assert.equal(sessions.status().seen, true);
});

test("stale sessions expire and report idle time from their last heartbeat", () => {
  let now = 1000;
  const sessions = createSessionTracker({ staleMs: 100, clock: () => now });
  sessions.touch("a");
  now = 1200;
  const status = sessions.status();
  assert.equal(status.count, 0);
  assert.equal(status.seen, true);
  assert.equal(status.idleMs, 100);
});
