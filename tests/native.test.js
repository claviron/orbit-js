import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadNative, nativeTarget } from "../native.js";

test("loads packaged prebuilds and keeps source-only native builds separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orbit-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await copyFile(new URL("../native.js", import.meta.url), join(root, "native.js"));
  const { loadNative: load } = await import(pathToFileURL(join(root, "native.js")));
  for (const [platform, arch, target] of [
    ["darwin", "arm64", "darwin-arm64"],
    ["linux", "x64", "linux-x64-gnu"],
    ["linux", "arm64", "linux-arm64-gnu"],
    ["freebsd", "x64", "freebsd-x64"],
    ["freebsd", "arm64", "freebsd-arm64"],
  ]) {
    const binding = {};
    const requested = [];
    const capture = (path) => { requested.push(path); return binding; };
    assert.equal(load(platform, arch, capture), binding);
    assert.deepEqual(requested, [`./prebuilds/${target}/orbit.node`]);
    await mkdir(join(root, "native", target), { recursive: true });
    await writeFile(join(root, "native", target, "orbit.node"), "local fixture");
    requested.length = 0;
    assert.equal(load(platform, arch, capture), binding);
    assert.deepEqual(requested, [`./native/${target}/orbit.node`]);
  }
});

test("rejects unsupported platforms without attempting a load", () => {
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "x64"], ["linux", "ia32"]]) {
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
