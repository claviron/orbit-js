import assert from "node:assert/strict";
import { test } from "node:test";
import { Link, Session, createOrbit } from "../binding.js";
import { answerSession } from "../session.js";

function exchange(messages = [], metadata = {}) {
  const calls = [];
  const pending = Promise.withResolvers();
  return {
    calls, isSession: true, method: "CONNECT", url: "https://example.test/chat",
    headers: [["origin", "https://example.test"]], httpVersion: "2",
    sessionKind: "websocket", ...metadata,
    async acceptSession(limit, headers) { calls.push(["accept", limit, headers]); },
    async rejectSession(status, headers) { calls.push(["reject", status, headers]); },
    async receiveMessage() { return messages.length ? messages.shift() : pending.promise; },
    async sendText(text) { calls.push(["text", text]); },
    async sendBinary(bytes) { calls.push(["binary", [...bytes]]); },
    async closeSession(code, reason) { calls.push(["close", code, reason]); pending.resolve(null); },
    async abort() { calls.push(["abort"]); pending.resolve(null); },
  };
}

for (const [httpVersion, method, sessionKind] of [
  ["1.1", "GET", "websocket"],
  ["2", "CONNECT", "websocket"],
  ["3", "CONNECT", "webtransport"],
]) {
  test(`HTTP/${httpVersion} message session bypasses Fetch and preserves text/binary boundaries`, async () => {
    const incoming = exchange([
      { kind: "text", text: "hello" },
      { kind: "binary", data: Buffer.from([0, 255]) },
      { kind: "close", code: 1000, reason: "done" },
    ], { httpVersion, method, sessionKind });
    let delivered = false;
    const stopped = Promise.withResolvers();
    const handled = Promise.withResolvers();
    const link = new Link({
      async next() { if (!delivered) { delivered = true; return incoming; } return stopped.promise; },
      async nextControl() { return null; },
      async close() { stopped.resolve(null); },
    });
    const serving = link.serve(() => assert.fail("Not an HTTP request"), {
      async onSession(session) {
        try {
          assert.ok(session instanceof Session);
          assert.equal(session.method, method);
          assert.equal(session.httpVersion, httpVersion);
          assert.equal(session.transport, sessionKind);
          assert.equal(session.headers.get("origin"), "https://example.test");
          await session.accept({ maxMessageBytes: 1024, headers: { "x-session": "yes" } });
          for await (const message of session) await session.send(message);
          assert.equal(session.closeCode, 1000);
          assert.equal(session.closeReason, "done");
          assert.ok(session.closed && session.signal.aborted);
          handled.resolve();
        } catch (error) { handled.reject(error); throw error; }
      },
    });
    try { await handled.promise; }
    finally { await link.close(); await serving; }
    assert.deepEqual(incoming.calls, [
      ["accept", 1024, [["x-session", "yes"]]], ["text", "hello"], ["binary", [0, 255]],
    ]);
  });
}

test("session acceptance requires a declared bound and permits explicit rejection", async () => {
  const incoming = exchange();
  const session = new Session(incoming);
  for (const maxMessageBytes of [undefined, 0, -1, 1.5, 2 ** 32]) {
    await assert.rejects(session.accept({ maxMessageBytes }), /maxMessageBytes/);
  }
  await assert.rejects(session.send("not accepted"), /not accepted/);
  assert.throws(() => session.reject(200), /rejection requires/);
  await session.reject(403, { "x-reason": "origin" });
  assert.deepEqual(incoming.calls, [["reject", 403, [["x-reason", "origin"]]]]);
  assert.ok(session.closed);
});

test("unclaimed sessions are refused, without calling a Fetch handler", async () => {
  const incoming = exchange();
  await answerSession(incoming, undefined, []);
  assert.deepEqual(incoming.calls, [["reject", 501, []]]);
});

test("input FIN preserves output until the handler completes", async () => {
  const incoming = exchange([null]);
  await answerSession(incoming, async (session) => {
    await session.accept({ maxMessageBytes: 128 });
    assert.equal(await session.receive(), null);
    await session.send("after FIN");
  }, []);
  assert.deepEqual(incoming.calls, [["accept", 128, []], ["text", "after FIN"], ["close", 1000, ""]]);
});

test("application stop resets a blocked session and joins its cleanup", async () => {
  const incoming = exchange();
  const reading = Promise.withResolvers();
  const generation = new AbortController();
  const dispatch = answerSession(incoming, async (session) => {
    await session.accept({ maxMessageBytes: 128 });
    const message = session.receive();
    reading.resolve();
    assert.equal(await message, null);
    assert.ok(session.signal.aborted);
  }, [generation.signal]);
  await reading.promise;
  generation.abort();
  await dispatch;
  assert.deepEqual(incoming.calls, [["accept", 128, []], ["abort"]]);
});

test("stop interrupts a graceful close parked behind backpressure", async () => {
  const incoming = exchange();
  const closing = Promise.withResolvers();
  const released = Promise.withResolvers();
  incoming.closeSession = async () => { closing.resolve(); await released.promise; throw new Error("reset"); };
  incoming.abort = async () => { incoming.calls.push(["abort"]); released.resolve(); };
  const generation = new AbortController();
  const dispatch = answerSession(incoming, async (session) => {
    await session.accept({ maxMessageBytes: 128 });
    await session.close();
  }, [generation.signal]);
  await closing.promise;
  generation.abort();
  await dispatch;
  assert.equal(incoming.calls.at(-1)[0], "abort");
});

test("shutdown already signalled refuses pending sessions without invoking the handler", async () => {
  const incoming = exchange();
  const generation = new AbortController();
  generation.abort();
  await answerSession(incoming, () => assert.fail("stopped"), [generation.signal]);
  assert.deepEqual(incoming.calls, [["reject", 503, []]]);
});

test("serve routes onSession to dispatch rather than native join options", async () => {
  const incoming = exchange();
  const ended = Promise.withResolvers();
  const signal = new AbortController();
  let delivered = false;
  const orbit = createOrbit({ async join(options) {
    assert.equal(options.onSession, undefined);
    return {
      async next() { if (!delivered) { delivered = true; return incoming; } return ended.promise; },
      async nextControl() { return null; },
      async close() { ended.resolve(null); },
    };
  } });
  await orbit.serve({ fleet: "example", name: "chat", frameworks: [], signal: signal.signal,
    async onSession(session) { await session.reject(403); signal.abort(); },
  }, () => assert.fail("Not HTTP"));
  assert.deepEqual(incoming.calls, [["reject", 403, []]]);
});
