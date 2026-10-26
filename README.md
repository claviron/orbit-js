# orbit-js

## Rust development

The root crate is a Rust library built on Claviron's Link transport. Node-API is an optional
adapter selected with the `napi` feature.

- `src/`: Link, exchanges, events and cells, independent of JavaScript types.
- `addon/`: the small ready-to-load native module.
- `examples/rust-addon/`: an application's own native module, with a Rust
  function and Orbit bindings in the same binary.

An application addon enables `orbit-js`'s `napi` feature and calls:

```rust
orbit_js::export_bindings!();
```

This emits the bindings in the final addon, where Node-API registers them.
Application functions can be exported alongside them with `#[napi]`. The
transport implementation stays in the shared library.

The JavaScript adapter can use that application's binary explicitly:

```js
import { createOrbit } from "./binding.js";
const orbit = createOrbit(native);
```

The binding entry does not load a bundled binary, probe the platform or invoke
Cargo. The default package entry retains automatic selection of a prebuilt
binary. See [the Rust addon example](examples/rust-addon/README.md).

Application introductions use Claviron's common management description:
JavaScript runtime, orbit-js runner and fetch request mode. Pass the framework
explicitly with `join({ fleet, name, frameworks: ["Hono"] })`; it is optional and
an explicit list is preserved, including `[]` to suppress discovery. The scalar
`framework` option remains a one-label shorthand. Otherwise, `join` reads the nearest
`package.json` above the application's working directory. Its `dependencies`
and `peerDependencies` identify Hono, Elysia, Express, Fastify, Koa, NestJS or
Hapi; multiple distinct frameworks remain separate tags. Development dependencies
and framework helper packages do not count. Start the process in its
application directory, not the installed Orbit package directory.
Missing or unrecognized metadata remains unknown; unreadable or malformed
metadata emits a warning without preventing join. In Deno, detection follows
the runtime's file-read permissions; an explicit framework skips file reads.
The native lifecycle owner stores the resolved description once, and includes
it in existing Link status reports, never HTTP dispatch. This metadata does not
import frameworks or select application behavior.
Description-bearing application reports require matching rebuilt native addons
and edges; no Link/stream SHM geometry changes or automatic cleanup is needed.

Pass `icon: "javascript"` or a known GUI icon code such as `"server"` to select
the admin-client icon. Unknown/absent codes use the runtime default; no image
bytes, filesystem path or URL cross the Link, and dispatch is unchanged.

Serve a JavaScript application — Deno, Node or Bun — behind a Claviron edge
over Orbit Link, with the whole JavaScript ecosystem and no runner around it.

```js
import { serve } from "@claviron/orbit";

await serve({ fleet: "shop", name: "storefront" }, async (request) => {
  return new Response(`hello from ${new URL(request.url).pathname}`);
});
```

The edge routes a host or path to the `storefront` name in the `shop` fleet;
this process takes a lane there and answers. Deno needs `--allow-ffi` to load
the module.

Status: early; see `PLAN.md`.

On macOS arm64, an HTTP/1.1 load check completed with Node 24.13.1 and eight
application processes. Deno 2.9.8 can stop progressing at native-to-JavaScript
completion under sustained load with eight processes; that investigation remains open.

## WebSocket and WebTransport

Use `onSession` for WebSockets over HTTP/1.1 or HTTP/2, and reliable
bidirectional WebTransport streams over HTTP/3. HTTP and SSE continue through
the Fetch handler. The edge owns the network handshake and protocol framing;
JavaScript receives message sessions over the same Link.

```js
await serve({
  fleet: "shop",
  name: "storefront",
  async onSession(session) {
    // Check session.url and session.headers before accepting, or reject(403).
    await session.accept({ maxMessageBytes: 64 * 1024 });
    for await (const message of session) {
      await session.send(message);
    }
  },
}, (request) => new Response("HTTP response"));
```

For an existing Link, use `link.serve(fetchHandler, { onSession })`.
`session.transport` is `websocket` or `webtransport`; `httpVersion` is
`1.1`, `2` or `3`. `method` and request headers retain the original values,
including `CONNECT` for HTTP/2 and HTTP/3.

`accept` requires a positive `maxMessageBytes`, measured in UTF-8 bytes for
text. `receive()` returns a string, a `Uint8Array`, or `null` at input end.
Await each `send()`; one reader and one writer can run independently, and
concurrent reads or concurrent writes are rejected rather than queued.
Input FIN leaves output usable. A received Close completes the close handshake;
`closeCode` and `closeReason` describe it. `close(code, reason)` sends a close
record and finishes output; `abort()` resets the stream and wakes blocked IO.

The handler owns the session until it returns. An accepted session then closes
normally; an unanswered one is rejected with 501. `reject(status, headers)`
refuses admission explicitly. Stop, restart or Link closure aborts the session's
`signal` and resets accepted streams, including backpressured writes. New
sessions can be served after restart. No handler means session requests get 501.

Each WebTransport bidi stream is a separate message session. Its client uses
the Link record format: a one-byte kind, a four-byte little-endian payload
length, then the payload. Kinds are 1 (UTF-8 text), 2 (binary), and 8 (close:
little-endian u16 code plus UTF-8 reason). Datagrams, unidirectional streams and
server-created WebTransport streams are outside this API.

These APIs require matching rebuilt edge and native-addon code. The
`examples/session.rs` probe exercises two concurrent Link sessions with text,
binary data larger than the stream buffer, and a close handshake; it does not
open a network listener.

## Native binaries

Release packages contain prebuilt Node-API 8 modules for macOS arm64 and
Linux x64 (glibc). The loader selects the local platform; installation does
not run Cargo or download an executable from another server. Musl, Windows,
Linux arm64 and Intel macOS are not supported by this initial package.

The npm package is not published yet. Maintainers build each binary on its target
platform with `npm run build` (release) or `npm run build -- debug` for local
development. These commands build the `addon/` workspace member. The binaries are staged under
`native/darwin-arm64/` and `native/linux-x64-gnu/`, not the old root `orbit.node`.

To collect a binary built elsewhere, use
`node scripts/stage-native.js RUST_TARGET ARTIFACT_PATH` with
`aarch64-apple-darwin` or `x86_64-unknown-linux-gnu`.
Run `npm test` for loader tests and `npm run check:package` to check both
artifacts before packaging. `npm pack` also runs this completeness check;
each binary still needs a load test on its target runtime before release.
The Linux build host determines the required glibc baseline: build on the
oldest supported environment rather than assuming every Linux installation
can load a binary built on a newer distribution.

### HTTP exchange completion

Completing a response releases both native stream halves, including unread
request input. A pending input read is woken through the exchange's cancellation
signal before its half is released. Keeping a JavaScript wrapper alive does not
keep a completed HTTP exchange's stream slot claimed; reuse does not depend on
garbage collection. Message sessions retain their separate close handshake.
