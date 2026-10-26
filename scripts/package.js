import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Build the consumer package without ever replacing the repository README.
export async function withPackage(root, use) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const stage = await mkdtemp(join(tmpdir(), "orbit-package-"));
  try {
    // Source-only commands must not run inside the published consumer package.
    const { scripts, ...published } = manifest;
    if (!Array.isArray(manifest.files) || !manifest.files.includes("README.md")) {
      throw new Error("package.json must declare an explicit files list including README.md");
    }
    for (const file of manifest.files) {
      if (typeof file !== "string" || isAbsolute(file) || file.split(/[\\/]/).some((part) => part === "..") ||
        /[\\*?{}[\]!]/.test(file) || file === "package.json") {
        throw new Error(`Package files must be explicit repository-relative file paths: ${file}`);
      }
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(root, file === "README.md" ? "npm/README.md" : file), destination);
    }
    await writeFile(join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    return await use(stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("Use scripts/publish.sh --dry-run or --publish to package npm/README.md after release checks. Direct npm pack/publish from the source repository is disabled.");
  process.exitCode = 1;
}
