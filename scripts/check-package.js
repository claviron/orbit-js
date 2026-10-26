import { checkPackage } from "./release.js";

try {
  if (!await checkPackage()) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
