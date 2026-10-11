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
  #controlling = false;
  #lifecycle = new Set();
  #commands = new Map();
  #shutdown = new Set();
  #generation = new AbortController();

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
    this.#control();
    for (;;) {
      const exchange = await this.#native.next();
      if (exchange === null) {
        return;
      }
      answer(exchange, handler, this.#generation.signal);
    }
  }

  /**
   * Whether the application is running. The edge stops, starts and restarts
   * the application, not this process: while stopped, the lane stays and
   * requests are answered 503 without reaching the handler.
   */
  get running() {
    return this.#native.running;
  }

  /**
   * Aborts when the edge stops or restarts the application. Each request's
   * own `request.signal` follows it, so work a request started is cancelled
   * and its reply abandoned rather than left open. Work the application keeps
   * outside requests can follow this one.
   */
  get signal() {
    return this.#generation.signal;
  }

  /**
   * Call `listener` with `"start"`, `"stop"` or `"restart"` after the edge
   * changed the application. On stop and restart, `signal` has already
   * aborted; a restart is the moment to rebuild what the application holds.
   *
   * @param {(action: "start" | "stop" | "restart") => void} listener
   */
  onLifecycle(listener) {
    this.#lifecycle.add(listener);
    this.#control();
    return this;
  }

  /**
   * Call `listener` for each command named `name` the edge forwards to this
   * application, with its payload bytes.
   *
   * @param {string} name
   * @param {(payload: Uint8Array) => void} listener
   */
  onCommand(name, listener) {
    let listeners = this.#commands.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#commands.set(name, listeners);
    }
    listeners.add(listener);
    this.#control();
    return this;
  }

  /**
   * Call `listener` when the edge in front of this application announces it
   * is shutting down. The Link stays; what to do about it is the
   * application's decision.
   *
   * @param {(edge: string) => void} listener
   */
  onShutdown(listener) {
    this.#shutdown.add(listener);
    this.#control();
    return this;
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

  /**
   * The fleet's Orbit cells, shared with every instance of this application:
   * `cells.int(0)`, `float`, `bool`, `string`, or `cells.open(id)`. A cell
   * offers `get`, `set`, atomic `add` / `append`, `version` and
   * `await wait(since)`, woken by the write itself.
   */
  get cells() {
    return this.#native.cells;
  }

  /** Stop being a target and stop taking events; the lane is released. */
  close() {
    return this.#native.close();
  }

  async #control() {
    if (this.#controlling) {
      return;
    }
    this.#controlling = true;
    for (;;) {
      const control = await this.#native.nextControl();
      if (control === null) {
        return;
      }
      switch (control.kind) {
        case "lifecycle":
          if (control.action === "stop" || control.action === "restart") {
            this.#generation.abort(
              new DOMException(`application ${control.action}`, "AbortError"),
            );
            this.#generation = new AbortController();
          }
          notify(this.#lifecycle, control.action, `lifecycle '${control.action}'`);
          break;
        case "command":
          notify(
            this.#commands.get(control.name) ?? [],
            new Uint8Array(control.payload ?? []),
            `command '${control.name}'`,
          );
          break;
        case "shutdown":
          notify(this.#shutdown, control.edge, "edge shutdown");
          break;
      }
    }
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

function notify(listeners, value, what) {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error(`orbit-js: listener for ${what} failed`, error);
    }
  }
}

// Answer one exchange. `generation` aborts when the edge stops or restarts the
// application: the request's signal follows it, a handler still running is
// no longer waited for, and a body still streaming is cut — the edge, and the
// client behind it, are never left holding an open reply.
async function answer(exchange, handler, generation) {
  const controller = new AbortController();
  const signal = controller.signal;
  const follow = () => controller.abort(generation.reason);
  if (generation.aborted) {
    follow();
  } else {
    generation.addEventListener("abort", follow, { once: true });
  }
  const stopped = new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
  const handled = Promise.resolve().then(() => handler(request(exchange, signal)));
  // A handler outrun by the abort settles later; its result goes nowhere.
  handled.then(
    (late) => signal.aborted && late?.body?.cancel(signal.reason).catch(() => {}),
    () => {},
  );
  try {
    let response;
    try {
      response = await Promise.race([handled, stopped]);
    } catch (error) {
      if (!signal.aborted) {
        console.error("orbit-js: handler failed", error);
        response = new Response("Internal Server Error", { status: 500 });
      }
    }
    if (signal.aborted) {
      await exchange.abort();
      return;
    }
    await reply(exchange, response, signal);
  } finally {
    generation.removeEventListener("abort", follow);
  }
}

async function reply(exchange, response, signal) {
  const reader = response.body?.getReader();
  // A write may be parked on a slow client; aborting the exchange frees it.
  const cancel = () => {
    reader?.cancel(signal.reason).catch(() => {});
    exchange.abort();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    exchange.respond(response.status, [...response.headers]);
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await exchange.write(value);
      }
    }
    if (signal.aborted) {
      await exchange.abort();
    } else {
      await exchange.end();
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error("orbit-js: reply failed", error);
    }
    reader?.cancel(error).catch(() => {});
    await exchange.abort();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function request(exchange, signal) {
  const method = exchange.method;
  const init = { method, headers: exchange.headers, signal };
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
