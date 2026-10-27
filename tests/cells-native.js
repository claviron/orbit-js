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
} finally { await link.close(); }
