import { readFile } from "node:fs/promises";
import { nativeTargets } from "../native.js";

// This checks release completeness and architecture, not runtime/ABI compatibility.
let failed = false;
for (const target of Object.keys(nativeTargets)) {
  try {
    const bytes = await readFile(new URL(`../native/${target}/orbit.node`, import.meta.url));
    const valid = target === "darwin-arm64"
      ? bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf &&
        bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 6
      : bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(16) === 3 &&
        bytes.readUInt16LE(18) === 62;
    if (!valid) throw new Error("not a shared library for the declared architecture");
    console.log(`${target}: present`);
  } catch (error) {
    failed = true;
    console.error(`${target}: ${error.message}`);
  }
}
if (failed) process.exitCode = 1;
