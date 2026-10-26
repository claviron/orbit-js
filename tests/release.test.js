import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { nativeTarget, nativeTargets } from "../native.js";
import { inspectPackage, sourceDigest } from "../scripts/release.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function binary(target) {
  const bytes = Buffer.alloc(64);
  if (target === "darwin-arm64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    bytes.writeUInt32LE(6, 12);
  } else {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes[7] = target.startsWith("freebsd-") ? 9 : 0;
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(target.includes("arm64") ? 183 : 62, 18);
  }
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "orbit-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["src", "addon/src", "scripts/lib"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const file of ["native.js", "scripts/release.js", "scripts/stage-native.js", "scripts/publish.sh", "scripts/sync.js", "scripts/lib/cargo.sh"]) {
    await copyFile(join(repository, file), join(root, file));
  }
  for (const file of ["Cargo.toml", "Cargo.lock", "addon/Cargo.toml", "addon/build.rs", "src/lib.rs", "addon/src/lib.rs", "index.js", "binding.js", "session.js", "framework.js"]) {
    await writeFile(join(root, file), "fixture\n");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "example-addon", version: "1.0.0", type: "module" }));
  return root;
}

async function prepared(root, target) {
  const bytes = binary(target);
  const directory = join(root, "prebuilds", target);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "orbit.node"), bytes);
  await writeFile(join(directory, "release.json"), JSON.stringify({
    format: 1, package: "example-addon", napi: 8, target: nativeTargets[target], version: "1.0.0", profile: "release",
    cpu: target.includes("arm64") ? "generic" : "x86-64",
    source: await sourceDigest(root), sha256: hash(bytes),
  }));
}

test("reports every missing target and a wrong architecture together", async (t) => {
  const root = await fixture(t);
  await prepared(root, "darwin-arm64");
  await prepared(root, "linux-arm64-gnu");
  await writeFile(join(root, "prebuilds/linux-arm64-gnu/orbit.node"), binary("linux-x64-gnu"));
  const results = await inspectPackage(root);
  assert.equal(results.length, 5);
  assert.deepEqual(results.filter((entry) => entry.ready).map((entry) => entry.target), ["darwin-arm64"]);
  assert.match(results.find((entry) => entry.target === "linux-arm64-gnu").error, /architecture/);
  assert.equal(results.filter((entry) => !entry.ready).length, 4);
});

test("rejects a replaced binary, nonportable receipt and stale sources", async (t) => {
  const root = await fixture(t);
  for (const target of Object.keys(nativeTargets)) await prepared(root, target);
  assert.ok((await inspectPackage(root)).every((entry) => entry.ready));
  await writeFile(join(root, "prebuilds/linux-x64-gnu/orbit.node"), Buffer.concat([binary("linux-x64-gnu"), Buffer.from("changed")]));
  const receiptPath = join(root, "prebuilds/freebsd-arm64/release.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, cpu: "native" }));
  assert.equal((await inspectPackage(root)).filter((entry) => !entry.ready).length, 2);
  await writeFile(join(root, "src/lib.rs"), "changed source\n");
  assert.ok((await inspectPackage(root)).every((entry) => !entry.ready));
});

test("prepare overrides native flags; publication requires every prepared target and an explicit action", async (t) => {
  const root = await fixture(t);
  const commands = join(root, "commands");
  await mkdir(commands);
  const log = join(root, "commands.jsonl");
  const cargo = join(commands, "cargo");
  await writeFile(cargo, `#!${process.execPath}\n` + `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: 'cargo', args: process.argv.slice(2), flags: process.env.CARGO_ENCODED_RUSTFLAGS }) + '\\n');
const target = process.argv[process.argv.indexOf('--target') + 1];
const directory = join(process.env.CARGO_TARGET_DIR, target, 'release');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, process.platform === 'darwin' ? 'liborbit_js_addon.dylib' : 'liborbit_js_addon.so'), Buffer.from(${JSON.stringify([...binary(nativeTarget())])}));
`);
  const npm = join(commands, "npm");
  await writeFile(npm, `#!${process.execPath}\n` + `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: 'npm', args: process.argv.slice(2) }) + '\\n');
`);
  await chmod(cargo, 0o755);
  await chmod(npm, 0o755);
  const env = { ...process.env, PATH: `${commands}:${process.env.PATH}`, COMMAND_LOG: log,
    CARGO_TARGET_DIR: join(root, "output"), CARGO_ENCODED_RUSTFLAGS: "-C\x1ftarget-cpu=native" };
  const invoke = (...args) => spawnSync("bash", [join(root, "scripts/publish.sh"), ...args], { env, encoding: "utf8" });
  assert.equal(invoke().status, 0);
  assert.equal(invoke("--publish", "--prepare").status, 2);
  const local = join(root, "native", nativeTarget());
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "orbit.node"), "local build stays untouched");
  const preparation = invoke("--prepare");
  assert.equal(preparation.status, 0, preparation.stderr);
  assert.equal(await readFile(join(local, "orbit.node"), "utf8"), "local build stays untouched");
  let calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cargo");
  assert.equal(calls[0].flags, `-C\x1ftarget-cpu=${process.arch === "arm64" ? "generic" : "x86-64"}`);
  assert.ok(calls[0].args.includes("--release"));
  assert.equal(invoke("--publish").status, 1);
  assert.equal(invoke("--dry-run").status, 1);
  for (const target of Object.keys(nativeTargets)) await prepared(root, target);
  assert.equal(invoke("--dry-run").status, 0);
  assert.equal(invoke("--publish").status, 0);
  calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(1), [
    { command: "npm", args: ["publish", "--access", "public", "--dry-run"] },
    { command: "npm", args: ["publish", "--access", "public"] },
  ]);
});


test("sync verifies the active release, reports missing files and preserves rejected targets", async (t) => {
  const root = await fixture(t);
  const remote = await fixture(t);
  for (const target of ["linux-arm64-gnu", "freebsd-arm64"]) {
    await prepared(remote, target);
    await writeFile(join(remote, "prebuilds", target, "unrelated.txt"), "must not transfer");
  }
  await prepared(root, "freebsd-arm64");
  const receiptPath = join(remote, "prebuilds/freebsd-arm64/release.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, version: "0.9.0" }));
  const commands = join(root, "commands");
  await mkdir(commands);
  const rsync = join(commands, "rsync");
  const log = join(root, "rsync.jsonl");
  await writeFile(rsync, `#!${process.execPath}\n` + `
import { appendFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + '\\n');
for (const file of ['orbit.node', 'release.json']) {
 const source = join(args.at(-2), file);
 if (existsSync(source)) copyFileSync(source, join(args.at(-1), file));
}
`);
  await chmod(rsync, 0o755);
  const targets = {};
  for (const target of ["linux-arm64-gnu", "freebsd-arm64", "linux-x64-gnu"]) {
    targets[target] = { source: join(remote, "prebuilds", target) };
  }
  const config = join(root, "sync.json");
  await writeFile(config, JSON.stringify({ targets }));
  const result = spawnSync(process.execPath, [join(root, "scripts/sync.js"), "--config", config], {
    encoding: "utf8", env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, COMMAND_LOG: log },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /linux-arm64-gnu: collected and verified/);
  assert.match(result.stderr, /freebsd-arm64: preparation does not match/);
  assert.match(result.stderr, /linux-x64-gnu:.*ENOENT/);
  const inspected = await inspectPackage(root);
  assert.ok(inspected.find((entry) => entry.target === "linux-arm64-gnu").ready);
  assert.ok(inspected.find((entry) => entry.target === "freebsd-arm64").ready);
  await assert.rejects(readFile(join(root, "prebuilds/linux-arm64-gnu/unrelated.txt")), { code: "ENOENT" });
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.ok(args.includes("--include=/orbit.node"));
    assert.ok(args.includes("--include=/release.json"));
    assert.ok(args.includes("--exclude=*"));
  }
});

test("npm package contains portable prebuilds and excludes local native files and receipts", async (t) => {
  const root = await fixture(t);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const published = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  await writeFile(join(root, "package.json"), JSON.stringify({ ...manifest, files: published.files }));
  for (const target of Object.keys(nativeTargets)) {
    await prepared(root, target);
    await mkdir(join(root, "native", target), { recursive: true });
    await writeFile(join(root, "native", target, "orbit.node"), "local native binary");
  }
  await mkdir(join(root, "prebuilds", "unrecognized"), { recursive: true });
  await writeFile(join(root, "prebuilds", "unrecognized", "orbit.node"), "must not publish");
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", join(root, "npm-cache")], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  for (const target of Object.keys(nativeTargets)) assert.ok(files.includes(`prebuilds/${target}/orbit.node`));
  assert.ok(!files.some((file) => file.startsWith("native/")));
  assert.ok(!files.some((file) => file.endsWith("release.json")));
  assert.ok(!files.some((file) => file.includes("sync")));
  assert.ok(!files.some((file) => file.includes("unrecognized")));
  assert.equal(files.filter((file) => file.endsWith(".node")).length, 5);
});
