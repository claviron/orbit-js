// deno run --allow-ffi --allow-read --allow-env examples/hello.js <fleet> <name>
// node examples/hello.js <fleet> <name>
// bun examples/hello.js <fleet> <name>
import process from "node:process";
import { serve } from "../index.js";

const [fleet = "apps", name = "hello-js"] = process.argv.slice(2);
console.log(`serving '${name}' in fleet '${fleet}'`);

// Ctrl-C releases the lane before the process exits.
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

await serve({ fleet, name, signal: stop.signal }, async (request) => {
  const url = new URL(request.url);
  const body = request.body ? await request.text() : "";
  return Response.json({
    runtime: typeof Deno !== "undefined" ? "deno" : typeof Bun !== "undefined" ? "bun" : "node",
    method: request.method,
    path: url.pathname,
    query: url.search,
    received: body.length,
  });
});
console.log(`released '${name}'`);
