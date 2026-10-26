// Explicit native integration check; does not join a fleet or start a service.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../target/debug/example.node");
assert.equal(native.greeting("JavaScript"), "Hello, JavaScript, from the application's Rust module!");
for (const name of ["join", "Link", "Exchange", "Cells", "Cell"]) {
  assert.equal(typeof native[name], "function", `${name} is registered in the application's addon`);
}
console.log("Application Rust function and Orbit bindings loaded from one native module.");
