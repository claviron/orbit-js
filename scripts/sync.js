import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTargets } from "../native.js";
import { readPrepared, releaseContext, sourceDigest, stagePrepared } from "./release.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function synchronize(configPath, root = repository) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.targets || typeof config.targets !== "object" || Array.isArray(config.targets) ||
    !Object.keys(config.targets).length) throw new Error("Sync config requires a non-empty targets object.");
  const context = await releaseContext(root);
  let complete = true;
  for (const [target, entry] of Object.entries(config.targets)) {
    let temporary;
    try {
      if (!Object.hasOwn(nativeTargets, target)) throw new Error("target is outside the release matrix");
      if (!entry || typeof entry.source !== "string" || !entry.source.trim() || entry.source.startsWith("-")) {
        throw new Error("target requires a source directory");
      }
      const source = entry.source.includes(":") ? entry.source : resolve(dirname(configPath), entry.source);
      const destination = join(root, "prebuilds", target);
      if (!source.includes(":") && resolve(source) === resolve(destination)) {
        await readPrepared(target, destination, context);
        console.log(`${target}: already present and verified for ${context.version}`);
        continue;
      }
      await mkdir(join(root, "prebuilds"), { recursive: true });
      temporary = await mkdtemp(join(root, "prebuilds", `.sync-${target}-`));
      // Only these two files cross the host boundary. No repo sync or remote build.
      const result = spawnSync("rsync", ["-rt", "--include=/orbit.node", "--include=/release.json",
        "--exclude=*", "--", `${source.replace(/\/$/, "")}/`, `${temporary}/`], {
        cwd: root, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`rsync failed (${result.signal ?? result.status}): ${result.stderr.trim()}`);
      const { bytes, receipt } = await readPrepared(target, temporary, context);
      if (context.source !== await sourceDigest(root)) throw new Error("sources changed during sync; repeat after sources settle");
      await stagePrepared(root, target, bytes, receipt);
      console.log(`${target}: collected and verified for ${context.version}`);
    } catch (error) {
      complete = false;
      console.error(`${target}: ${error.message}`);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  console.log("Sync finished. No build or publication was started.");
  return complete;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log("Usage: scripts/sync.sh [--config PATH]\nDefault: .release-sync.local.json (kept outside Git).\nCollects only orbit.node and release.json; never builds or publishes.");
    } else {
      if (args.length && (args.length !== 2 || args[0] !== "--config" || !args[1])) {
        throw new Error("Use scripts/sync.sh [--config PATH]");
      }
      const config = resolve(repository, args[1] || ".release-sync.local.json");
      if (!await synchronize(config)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
