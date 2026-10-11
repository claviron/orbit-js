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
  // /bytes/<n>: a reply body of n bytes, streamed in pieces.
  const size = url.pathname.match(/^\/bytes\/(\d+)$/);
  if (size) {
    let left = Number(size[1]);
    const piece = new Uint8Array(16 * 1024).fill(98);
    return new Response(new ReadableStream({
      pull(controller) {
        if (left <= 0) return controller.close();
        const next = piece.subarray(0, Math.min(left, piece.length));
        left -= next.length;
        controller.enqueue(next);
      },
    }));
  }
  const body = request.body ? await request.text() : "";
  // Echo a body back, so a round trip through both stream directions shows.
  return Response.json({
    runtime: typeof Deno !== "undefined" ? "deno" : typeof Bun !== "undefined" ? "bun" : "node",
    method: request.method,
    path: url.pathname,
    query: url.search,
    received: body.length,
    echo: body.slice(0, 64),
  });
});
console.log(`released '${name}'`);
