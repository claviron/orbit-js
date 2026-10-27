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

function pendingHttp() {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const withdrawn = Promise.withResolvers();
  const terminal = Promise.withResolvers();
  let delivered = false;
  let ended = false;
  const link = new Link({
    async next() {
      if (delivered) return withdrawn.promise;
      delivered = true;
      return {
        method: "GET", url: "https://example.test/slow", headers: [], hasBody: false,
        waitClosed: () => terminal.promise,
        respond() {}, async write() {},
        async end() { ended = true; terminal.resolve(false); },
        async abort() { terminal.resolve(true); },
      };
    },
    async nextControl() { return null; },
    async close() { withdrawn.resolve(null); },
  });
  return { link, started, response, ended: () => ended };
}

test("serve joins an accepted HTTP response after close withdraws the lane", async () => {
  const f = pendingHttp();
  let completed = false;
  const serving = f.link.serve(() => {
    f.started.resolve(); return f.response.promise;
  }).then(() => { completed = true; });
  await f.started.promise;
  await f.link.close();
  assert.equal(completed, false);
  assert.equal(f.ended(), false);
  f.response.resolve(new Response("done"));
  await serving;
  assert.equal(f.ended(), true);
});

test("serve joins asynchronous response-body cancellation cleanup", async () => {
  const cancelled = Promise.withResolvers();
  const cleaned = Promise.withResolvers();
  const terminal = Promise.withResolvers();
  const started = Promise.withResolvers();
  let delivered = false;
  const link = new Link({
    async next() {
      if (delivered) return null;
      delivered = true;
      return {
        method: "GET", url: "https://example.test/idle", headers: [], hasBody: false,
        waitClosed: () => terminal.promise,
        respond() { started.resolve(); }, async write() {},
        async end() { terminal.resolve(false); }, async abort() { terminal.resolve(true); },
      };
    },
    async nextControl() { return null; },
  });
  let completed = false;
  const serving = link.serve(() => new Response(new ReadableStream({
    cancel() { cancelled.resolve(); return cleaned.promise; },
  }))).then(() => { completed = true; });
  await started.promise;
  terminal.resolve(true);
  await cancelled.promise;
  assert.equal(completed, false);
  cleaned.resolve();
  await serving;
  assert.equal(completed, true);
});

for (const intakeFails of [false, true]) {
  test(`serving joins concurrent responses when intake ${intakeFails ? "fails" : "ends"}`, async () => {
    const bothStarted = Promise.withResolvers();
    const responses = [Promise.withResolvers(), Promise.withResolvers()];
    const ended = [];
    let next = 0;
    let started = 0;
    let withdrawn = false;
    const failure = new Error("fixture intake failure");
    const link = new Link({
      async next() {
        const id = next++;
        if (id === 2) {
          if (intakeFails) throw failure;
          return null;
        }
        const terminal = Promise.withResolvers();
        return {
          method: "GET", url: `https://example.test/${id}`, headers: [], hasBody: false,
          waitClosed: () => terminal.promise,
          respond() {}, async write() {},
          async end() { ended.push(id); terminal.resolve(false); },
          async abort() { terminal.resolve(true); },
        };
      },
      async nextControl() { return null; },
      async close() { withdrawn = true; },
    });
    let completed = false;
    const serving = link.serve((request) => {
      if (++started === 2) bothStarted.resolve();
      return responses[Number(new URL(request.url).pathname.slice(1))].promise;
    }).then(() => { completed = true; }, (error) => {
      assert.equal(error, failure); completed = true;
    });
    await bothStarted.promise;
    assert.equal(completed, false);
    responses[1].resolve(new Response("second"));
    responses[0].resolve(new Response("first"));
    await serving;
    assert.deepEqual(ended.sort(), [0, 1]);
    assert.equal(withdrawn, intakeFails);
  });
}
