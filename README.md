# orbit-js

Application introductions use Claviron's common management description:
JavaScript runtime, orbit-js runner and fetch request mode. Pass the framework
explicitly with `join({ fleet, name, framework: "Hono" })`; it is optional and
is not inferred from the name. The native lifecycle owner prepares this data
once, and includes it in existing Link status reports, never HTTP dispatch.
Description-bearing application reports require matching rebuilt native addons
and edges; no Link/stream SHM geometry changes or automatic cleanup is needed.

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
