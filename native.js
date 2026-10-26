import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);

export const nativeTargets = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "freebsd-x64": "x86_64-unknown-freebsd",
  "freebsd-arm64": "aarch64-unknown-freebsd",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
});

export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "freebsd" && arch === "x64") return "freebsd-x64";
  if (platform === "freebsd" && arch === "arm64") return "freebsd-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
  if (platform === "linux" && arch === "arm64") return "linux-arm64-gnu";
  throw new Error(
    `@claviron/orbit does not support ${platform}/${arch}. ` +
    "Supported platforms: macOS arm64, FreeBSD x64/arm64 and Linux x64/arm64 (glibc).",
  );
}

// Source builds stay local; npm packages contain only portable prebuilds.
// Paths stay package-relative; loading never compiles or searches another installation.
export function loadNative(platform = process.platform, arch = process.arch, load = require) {
  const target = nativeTarget(platform, arch);
  try {
    const local = `./native/${target}/orbit.node`;
    const path = existsSync(new URL(local, import.meta.url))
      ? local : `./prebuilds/${target}/orbit.node`;
    return load(path);
  } catch (cause) {
    throw new Error(
      `@claviron/orbit could not load its ${target} binary. ` +
      "Install a complete release package and use a runtime with Node-API 8 support. " +
      (platform === "linux" ? "The Linux binary requires glibc; musl is not supported. " : "") +
      "No source build was attempted.",
      { cause },
    );
  }
}
