// deno run --allow-ffi --allow-read --allow-env examples/hello.js <fleet> <name>
// node examples/hello.js <fleet> <name>
// bun examples/hello.js <fleet> <name>
import process from "node:process";
import { join } from "../index.js";

const [fleet = "apps", name = "hello-js"] = process.argv.slice(2);
console.log(`serving '${name}' in fleet '${fleet}'`);

// Ctrl-C releases the lane before the process exits.
const link = await join({ fleet, name });
process.on("SIGINT", () => link.close());
process.on("SIGTERM", () => link.close());

// The edge stops, starts and restarts the application; the process stays.
link.onLifecycle((action) => console.log(`lifecycle: ${action}`));
link.onCommand("ping", (payload) => console.log(`ping: ${new TextDecoder().decode(payload)}`));

await link.serve(async (request) => {
  const url = new URL(request.url);
  // /hang: never answers on its own; a stop or restart cancels it.
  if (url.pathname === "/hang") {
    return new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => {
        console.log(`/hang cancelled: ${request.signal.reason.message}`);
        reject(request.signal.reason);
      });
    });
  }
  // /open: a reply that sends one line and stays open until it is cancelled.
  if (url.pathname === "/open") {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("open\n"));
      },
      cancel(reason) {
        console.log(`/open cancelled: ${reason.message}`);
      },
    }));
  }
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
