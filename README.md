# orbit-js

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
