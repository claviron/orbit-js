import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeTargets } from "../native.js";

const [triple, source] = process.argv.slice(2);
const target = Object.keys(nativeTargets).find((key) => nativeTargets[key] === triple);
if (!target || !source || process.argv.length !== 4) {
  console.error("Usage: node scripts/stage-native.js RUST_TARGET ARTIFACT_PATH");
  process.exitCode = 2;
} else {
  const directory = new URL(`../native/${target}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const destination = new URL("orbit.node", directory);
  const temporary = new URL(`orbit.node.${process.pid}.tmp`, directory);
  try {
    await copyFile(source, temporary);
    // Replace the inode; never overwrite a native module a process may have mapped.
    await rename(temporary, destination);
    console.log(`Staged ${fileURLToPath(destination)}`);
  } finally {
    await rm(temporary, { force: true });
  }
}
