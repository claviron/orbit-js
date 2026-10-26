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

The release matrix contains five Node-API 8 addons:

| Platform | Rust target | Package directory |
| --- | --- | --- |
| macOS arm64 | `aarch64-apple-darwin` | `prebuilds/darwin-arm64/` |
| FreeBSD x64 | `x86_64-unknown-freebsd` | `prebuilds/freebsd-x64/` |
| FreeBSD arm64 | `aarch64-unknown-freebsd` | `prebuilds/freebsd-arm64/` |
| Linux x64, glibc | `x86_64-unknown-linux-gnu` | `prebuilds/linux-x64-gnu/` |
| Linux arm64, glibc | `aarch64-unknown-linux-gnu` | `prebuilds/linux-arm64-gnu/` |

The loader selects the local platform. Installation does not run Cargo or
fetch executables. Musl, Windows and Intel macOS are outside this matrix.
The npm package has not been published yet; each target needs runtime validation
on its own OS before release.

### Local development

`npm run build` or `scripts/build-native.sh` builds a local addon in release
mode; `npm run build -- debug` selects debug mode. It stages the file under
`native/<target>/`, keeps operator-supplied Rust flags and may use CPU-specific
optimizations for the build host. This directory is for development and tests
and is excluded from the npm package. A source checkout loads its local native
file when present; otherwise it selects the platform's portable prebuild.

On shared Linux/FreeBSD development mounts, build scripts use the configured
`set_cargo_target` helper when available. Without it, Cargo keeps its normal
output configuration.

### Prepare the active release

Use the same package version and addon sources on every build host:

```sh
scripts/publish.sh --prepare
```

Preparation builds only the current host's addon, stages it under
`prebuilds/<target>/`, then exits. Local `native/` files are unchanged.
It uses release mode with a portable CPU baseline (`x86-64` or AArch64
`generic`), replacing local Rust flags. `release.json` records the package
name, full version, Rust target, profile, CPU baseline, Node-API version,
source digest and binary checksum. The source digest covers the package's
Rust sources, manifests, lockfile and JavaScript adapter files.

The five targets share the active package version rather than independently
versioned binaries. Changing that version or those sources invalidates previous
preparation records. Prepared files and receipts stay outside Git.

### Collect prepared files

Synchronization is a separate operation. Put builder locations in an ignored
`.release-sync.local.json` file, for example:

```json
{
  "targets": {
    "linux-x64-gnu": {
      "source": "builder@linux.example.test:/srv/orbit/prebuilds/linux-x64-gnu/"
    },
    "freebsd-arm64": {
      "source": "builder@freebsd.example.test:/srv/orbit/prebuilds/freebsd-arm64/"
    }
  }
}
```

Each source is a directory with `orbit.node` and `release.json`. A local source
is resolved relative to the sync config; use local paths when checkouts share
one filesystem. Remote sources use rsync's `host:path` syntax. Configure only
the targets collected from builders; other targets may already be prepared
in the publishing checkout.

```sh
scripts/sync.sh
scripts/sync.sh --config /path/to/sync.local.json
```

The script transfers only the binary and its receipt into a temporary directory,
checks them against the active version and sources, then installs the verified
pair into `prebuilds/<target>/`. It reports each missing, invalid or unavailable
target and exits unsuccessfully if any configured target fails. Rejected targets
leave existing prepared files intact. A shared source already at the destination
is verified without copying. Sync neither builds nor publishes.

### Publish

Once all five prepared targets are present:

```sh
scripts/publish.sh --dry-run
scripts/publish.sh --publish
```

There is no default publication action. Missing targets, mismatched architectures,
stale receipts or modified binaries stop publication and are reported for every
target. `npm run check:package`, `npm pack` and npm's `prepublishOnly` hook use
the same check. A dry run performs npm's publication checks without uploading.
Publication does not synchronize or build missing targets automatically.

Only the portable `.node` files under `prebuilds/` enter the npm package;
`native/`, receipts and the private sync setup are excluded.
These checks inspect library headers and preparation metadata; they do not prove
runtime or OS ABI compatibility. Build Linux binaries on the oldest supported
glibc environment and validate each FreeBSD build on its supported OS version.

### FreeBSD x64 cross preparation

On a Linux x64 build host with Docker and the project's matching Rust toolchain:

```sh
rustup target add x86_64-unknown-freebsd
scripts/prepare-freebsd.sh
```

This uses `scripts/publish.sh --prepare --target x86_64-unknown-freebsd` inside
a Debian builder with the official, checksum-verified FreeBSD 14.4-RELEASE
amd64 sysroot. Rust's matching LLD links the addon. Compilation runs without
network access, using a read-only registry cache fetched by the host. Source
and toolchain mounts are read-only; only build caches and `prebuilds/` are
writable. Cargo's existing path dependencies must be available. Node-API 8 and
the portable `x86-64` CPU baseline remain unchanged.

The build requires a glibc-compatible Linux Rust toolchain. Image setup uses
Docker's default build network; installations without a bridge can set
`ORBIT_FREEBSD_BUILD_NETWORK=host` for that setup step. The compilation container
still uses `--network none`. `ORBIT_FREEBSD_CACHE` selects a separate cache
directory; `CARGO_BUILD_JOBS` controls build parallelism and the container CPU
limit (default 4).

Cross preparation produces a FreeBSD artifact and receipt, not a FreeBSD
execution result. Validate it on an actual supported FreeBSD runtime before
release. A Linux/System V ELF is rejected as a FreeBSD artifact even when its
architecture matches. Changes to the preparation scripts change the source
digest, so all targets must be prepared from those same updated sources.

### HTTP exchange completion

Completing a response releases both native stream halves, including unread
request input. A pending input read is woken through the exchange's cancellation
signal before its half is released. Keeping a JavaScript wrapper alive does not
keep a completed HTTP exchange's stream slot claimed; reuse does not depend on
garbage collection. Message sessions retain their separate close handshake.
