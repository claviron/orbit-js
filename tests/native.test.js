import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNative, nativeTarget } from "../native.js";

test("selects only the binary for the requested platform", () => {
  for (const [platform, arch, target] of [
    ["darwin", "arm64", "darwin-arm64"],
    ["linux", "x64", "linux-x64-gnu"],
  ]) {
    const binding = {};
    const requested = [];
    assert.equal(loadNative(platform, arch, (path) => {
      requested.push(path);
      return binding;
    }), binding);
    assert.deepEqual(requested, [`./native/${target}/orbit.node`]);
  }
});

test("rejects unsupported platforms without attempting a load", () => {
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "x64"], ["linux", "arm64"]]) {
    assert.throws(() => nativeTarget(platform, arch), /does not support/);
  }
});

test("preserves native load errors without falling back or building", () => {
  const cause = new Error("wrong ELF class");
  let calls = 0;
  assert.throws(() => loadNative("linux", "x64", () => {
    calls++;
    throw cause;
  }), (error) => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /glibc/);
    assert.match(error.message, /No source build was attempted/);
    return true;
  });
  assert.equal(calls, 1);
});
