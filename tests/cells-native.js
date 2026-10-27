// Explicit native regression check; run only with a freshly built addon in
// isolated mount/network/IPC namespaces with private /dev/shm.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const native = createRequire(import.meta.url)(resolve(process.argv[2]));
const link = await native.join({ fleet: "numbers", name: "numeric-fixture", frameworks: [] });
try {
  const cells = link.cells;
  const float = cells.float(0.25);
  const integer = cells.int(7);
  try {
    assert.equal(float.get(), 0.25);
    for (const value of [1.5, -1.5, NaN, Infinity, -Infinity]) {
      float.set(value);
      assert.ok(Object.is(float.get(), value));
    }
    for (const value of [1.5, -1.5, NaN, Infinity, -Infinity, 1e30, -1e30, 2 ** 63, -(2 ** 63) - 2048]) {
      assert.throws(() => cells.int(value), /whole number/);
      const version = integer.version();
      assert.throws(() => integer.set(value), /whole number/);
      assert.equal(integer.get(), 7);
      assert.equal(integer.version(), version);
      assert.throws(() => integer.add(value), /whole number/);
      assert.equal(integer.get(), 7);
      assert.equal(integer.version(), version);
    }
    for (const value of [-(2 ** 63), 2 ** 63 - 1024, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      const cell = cells.int(value);
      try {
        assert.equal(cell.get(), value);
        cell.set(0);
        cell.set(value);
        assert.equal(cell.get(), value);
      } finally { cell.release(); }
    }
    for (const value of [true, "text"]) {
      const cell = typeof value === "boolean" ? cells.bool(false) : cells.string("");
      try { cell.set(value); assert.equal(cell.get(), value); }
      finally { cell.release(); }
    }
    console.log("Native cell numeric constructors and setters passed.");
  } finally { integer.release(); float.release(); }

  for (const [cell, value] of [
    [cells.int(0), 1], [cells.float(0), 0.5], [cells.bool(false), true],
  ]) {
    try {
      const since = cell.version();
      assert.equal(typeof since, "number");
      for (const invalid of [-1, 0.5, NaN, Infinity, 2 ** 32, 1n]) {
        await assert.rejects(cell.wait(invalid), /scalar revision/);
        assert.equal(cell.version(), since);
      }
      const pending = cell.wait(since);
      cell.set(value);
      assert.equal(await pending, cell.version());
      assert.equal(typeof await cell.wait(since), "number");
    } finally { cell.release(); }
  }

  const text = cells.string("before");
  try {
    const since = text.version();
    assert.equal(typeof since, "bigint");
    for (const other of [since + (1n << 32n), (1n << 53n) + 1n, (1n << 64n) - 1n]) {
      assert.equal(await text.wait(other), since);
    }
    for (const invalid of [Number(since), -1n, 1n << 64n, (1n << 64n) + since]) {
      await assert.rejects(text.wait(invalid), /text revision/);
      assert.equal(text.version(), since);
    }
    const reopened = cells.open(text.id);
    const pending = reopened.wait(since);
    text.append(" after");
    const committed = await pending;
    assert.equal(typeof committed, "bigint");
    assert.notEqual(committed, since);
    assert.equal(committed, text.version());
    assert.equal(reopened.get(), "before after");
  } finally { text.release(); }
  console.log("Native scalar Number and text BigInt revision round trips passed.");
} finally { await link.close(); }
