// Serve a JavaScript application behind a Claviron edge over Orbit Link.
//
// The native module (orbit.node) takes a lane in the fleet's Link segment and
// hands each HTTP exchange the edge writes into it to this layer, which turns
// it into a standard Request and the handler's Response back into a reply.
// Deno, Node and Bun load the same module; Deno needs --allow-ffi.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./orbit.node");

/**
 * Take a lane in `fleet` under `name`.
 *
 * @param {{ fleet: string, name: string }} options
 * @returns {Promise<Link>}
 */
export async function join(options) {
  return new Link(await native.join(options));
}

/** This process's place in a Link fleet: requests in, events both ways. */
export class Link {
  #native;
  #listeners = new Map();
  #pumping = false;

  constructor(link) {
    this.#native = link;
  }

  /** The lane this process holds; its address, and its node in the fleet. */
  get lane() {
    return this.#native.lane;
  }

  /**
   * Answer requests with `handler` until the link closes. Exchanges run side
   * by side: a slow one does not hold the lane.
   *
   * @param {(request: Request) => Response | Promise<Response>} handler
   */
  async serve(handler) {
    for (;;) {
      const exchange = await this.#native.next();
      if (exchange === null) {
        return;
      }
      answer(exchange, handler);
    }
  }

  /**
   * Call `listener` for each application event on `topic`, from the other
   * instances of this application and from across the Link. Subscribing is
   * what tells the far side to send it.
   *
   * @param {string} topic
   * @param {(payload: unknown, event: { id: string, topic: string }) => void} listener
   */
  on(topic, listener) {
    let listeners = this.#listeners.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(topic, listeners);
      this.#native.subscribe([topic]);
    }
    listeners.add(listener);
    this.#pump();
    return this;
  }

  off(topic, listener) {
    const listeners = this.#listeners.get(topic);
    if (listeners?.delete(listener) && listeners.size === 0) {
      this.#listeners.delete(topic);
      this.#native.unsubscribe([topic]);
    }
    return this;
  }

  /**
   * Publish an application event to every application that subscribes to
   * `topic`, or with `target` only to that one. Returns the event id.
   *
   * @param {string} topic
   * @param {unknown} payload JSON-compatible
   * @param {{ target?: { runtime: string, name: string } }} [options]
   */
  publish(topic, payload, options = {}) {
    const target = options.target ? [options.target.runtime, options.target.name] : undefined;
    return this.#native.publish(topic, payload ?? null, target);
  }

  /** Stop being a target and stop taking events; the lane is released. */
  close() {
    return this.#native.close();
  }

  async #pump() {
    if (this.#pumping) {
      return;
    }
    this.#pumping = true;
    for (;;) {
      const event = await this.#native.nextEvent();
      if (event === null) {
        return;
      }
      for (const listener of this.#listeners.get(event.topic) ?? []) {
        try {
          listener(event.payload, { id: event.id, topic: event.topic });
        } catch (error) {
          console.error(`orbit-js: listener for '${event.topic}' failed`, error);
        }
      }
    }
  }
}

/**
 * Serve `handler` until `options.signal` aborts, then release the lane so the
 * edge stops choosing it. Requests already taken still finish.
 *
 * @param {{ fleet: string, name: string, signal?: AbortSignal }} options
 * @param {(request: Request) => Response | Promise<Response>} handler
 */
export async function serve(options, handler) {
  const { signal, ...where } = options;
  const link = await join(where);
  if (signal) {
    if (signal.aborted) {
      await link.close();
      return;
    }
    signal.addEventListener("abort", () => link.close(), { once: true });
  }
  await link.serve(handler);
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
