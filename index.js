// Serve a JavaScript application behind a Claviron edge over Orbit Link.
//
// The native module (orbit.node) takes a lane in the fleet's Link segment and
// hands each HTTP exchange the edge writes into it to this layer, which turns
// it into a standard Request and the handler's Response back into a reply.
// Deno, Node and Bun load the same module; Deno needs --allow-ffi.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./orbit.node");

/** Take a lane in `fleet` under `name`; returns the Link. */
export const join = native.join;

/**
 * Serve `handler` on the Link until `options.signal` aborts, then release the
 * lane so the edge stops choosing it. Requests already taken still finish.
 *
 * @param {{ fleet: string, name: string, signal?: AbortSignal }} options
 * @param {(request: Request) => Response | Promise<Response>} handler
 */
export async function serve(options, handler) {
  const { signal, ...where } = options;
  const link = await native.join(where);
  if (signal) {
    if (signal.aborted) {
      await link.close();
      return;
    }
    signal.addEventListener("abort", () => link.close(), { once: true });
  }
  for (;;) {
    const exchange = await link.next();
    if (exchange === null) {
      return;
    }
    // Exchanges run side by side: a slow one does not hold the lane.
    answer(exchange, handler);
  }
}

async function answer(exchange, handler) {
  let response;
  try {
    response = await handler(request(exchange));
  } catch (error) {
    console.error("orbit-js: handler failed", error);
    response = new Response("Internal Server Error", { status: 500 });
  }
  try {
    exchange.respond(response.status, [...response.headers]);
    if (response.body) {
      for await (const chunk of response.body) {
        await exchange.write(chunk);
      }
    }
    await exchange.end();
  } catch (error) {
    console.error("orbit-js: reply failed", error);
    await exchange.abort();
  }
}

function request(exchange) {
  const method = exchange.method;
  const init = { method, headers: exchange.headers };
  if (exchange.hasBody && method !== "GET" && method !== "HEAD") {
    init.body = new ReadableStream({
      async pull(controller) {
        const piece = await exchange.read();
        if (piece === null) {
          controller.close();
        } else {
          controller.enqueue(new Uint8Array(piece));
        }
      },
    });
    init.duplex = "half";
  }
  return new Request(exchange.url, init);
}
