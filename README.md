# orbit-js

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
