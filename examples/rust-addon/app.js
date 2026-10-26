import { createRequire } from "node:module";
import { createOrbit } from "../../binding.js";

const require = createRequire(import.meta.url);
const native = require("../../target/debug/example.node");
const orbit = createOrbit(native);

await orbit.serve({ fleet: "example", name: "rust-addon" }, () => {
  return new Response(native.greeting("JavaScript"));
});
