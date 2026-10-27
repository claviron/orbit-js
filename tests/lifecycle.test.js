import assert from "node:assert/strict";
import { test } from "node:test";
import { Link } from "../binding.js";

test("stop retains cancellation until activation publishes the next signal", async () => {
  let pending = Promise.withResolvers();
  let notified;
  const link = new Link({
    nextControl() { return pending.promise; },
    async close() { pending.resolve(null); },
  });
  const observations = [];
  link.onLifecycle((action) => {
    observations.push({ action, signal: link.signal });
    notified.resolve();
  });
  async function send(action) {
    notified = Promise.withResolvers();
    const current = pending;
    pending = Promise.withResolvers();
    current.resolve({ kind: "lifecycle", action });
    await notified.promise;
    assert.equal(observations.at(-1).action, action);
    assert.equal(observations.at(-1).signal, link.signal);
  }
  const first = link.signal;
  await send("stop");
  assert.equal(link.signal, first);
  assert.equal(first.aborted, true);
  await send("stop");
  assert.equal(link.signal, first);
  await send("start");
  const second = link.signal;
  assert.notEqual(second, first);
  assert.equal(second.aborted, false);
  await send("start");
  assert.equal(link.signal, second);
  await send("restart");
  const third = link.signal;
  assert.equal(second.aborted, true);
  assert.notEqual(third, second);
  assert.equal(third.aborted, false);
  await send("stop");
  await send("restart");
  assert.equal(third.aborted, true);
  assert.notEqual(link.signal, third);
  assert.equal(link.signal.aborted, false);
  await link.close();
});
