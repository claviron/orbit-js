import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTarget, nativeTargets } from "../native.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cpuFor = (target) => target.includes("arm64") ? "generic" : "x86-64";

// Inspect architecture and shared-library shape without loading a foreign binary.
export function validateBinary(target, bytes) {
  let valid;
  if (target === "darwin-arm64") {
    valid = bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 6;
  } else {
    const machine = target.includes("arm64") ? 183 : 62;
    const osabis = target.startsWith("freebsd-") ? [0, 9] : [0, 3];
    valid = bytes.length >= 64 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 && bytes[5] === 1 && osabis.includes(bytes[7]) &&
      bytes.readUInt16LE(16) === 3 && bytes.readUInt16LE(18) === machine;
  }
  if (!valid) throw new Error("not a shared library for the declared platform/architecture");
}

// Bind collected artifacts to this package's source, not a host or an output path.
export async function sourceDigest(root = repository) {
  const hash = createHash("sha256");
  async function include(relative) {
    const bytes = await readFile(join(root, relative));
    hash.update(relative).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  async function directory(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await directory(path);
      else if (entry.isFile()) await include(path);
    }
  }
  for (const path of ["package.json", "Cargo.toml", "Cargo.lock", "addon/Cargo.toml",
    "addon/build.rs", "native.js", "scripts/release.js", "scripts/stage-native.js"]) {
    await include(path);
  }
  await directory("src");
  await directory("addon/src");
  return hash.digest("hex");
}

export async function inspectPackage(root = repository) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const source = await sourceDigest(root);
  return Promise.all(Object.entries(nativeTargets).map(async ([target, triple]) => {
    try {
      const directory = join(root, "native", target);
      const bytes = await readFile(join(directory, "orbit.node"));
      validateBinary(target, bytes);
      const receipt = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
      if (receipt.target !== triple || receipt.version !== version ||
        receipt.profile !== "release" || receipt.cpu !== cpuFor(target) ||
        receipt.source !== source || receipt.sha256 !== digest(bytes)) {
        throw new Error("release preparation is stale or the binary changed; run --prepare on its host");
      }
      return { target, ready: true };
    } catch (error) {
      return { target, ready: false, error: error.message };
    }
  }));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

async function prepare() {
  const target = nativeTarget();
  const triple = nativeTargets[target];
  const cpu = cpuFor(target);
  const source = await sourceDigest();
  const { version } = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  console.log(`Preparing ${target}: release, target-cpu=${cpu} (local Rust flags are replaced).`);
  // Override developer CPU/feature flags for every Rust dependency as well as the addon.
  run("cargo", ["build", "--manifest-path", "addon/Cargo.toml", "--locked", "--release", "--target", triple], {
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: `-C\x1ftarget-cpu=${cpu}` },
  });
  if (source !== await sourceDigest()) throw new Error("sources changed during preparation; run --prepare again");
  const library = target === "darwin-arm64" ? "liborbit_js_addon.dylib" : "liborbit_js_addon.so";
  const artifact = join(process.env.CARGO_TARGET_DIR || "target", triple, "release", library);
  validateBinary(target, await readFile(resolve(repository, artifact)));
  run(process.execPath, ["scripts/stage-native.js", triple, artifact]);
  const directory = join(repository, "native", target);
  const bytes = await readFile(join(directory, "orbit.node"));
  const receipt = { target: triple, version, profile: "release", cpu, source, sha256: digest(bytes) };
  await writeFile(join(directory, "release.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Prepared native/${target}/; no package was published.`);
}

export async function checkPackage(root = repository) {
  const results = await inspectPackage(root);
  for (const result of results) {
    if (result.ready) console.log(`${result.target}: ready`);
    else console.error(`${result.target}: ${result.error}`);
  }
  return results.every((result) => result.ready);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || !["--prepare", "--publish", "--dry-run"].includes(action)) {
      throw new Error("Use scripts/publish.sh --prepare | --dry-run | --publish");
    }
    if (action === "--prepare") await prepare();
    else if (!await checkPackage()) process.exitCode = 1;
    else run("npm", ["publish", "--access", "public", ...(action === "--dry-run" ? ["--dry-run"] : [])]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
