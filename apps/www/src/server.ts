import { paraglideMiddleware } from "./paraglide/server.js"
import handler from "@tanstack/react-start/server-entry"

import { withCmsEdgeCache } from "./integrations/payload/edge-cache.server"

export default {
  async fetch(req: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    return paraglideMiddleware(req, () =>
      withCmsEdgeCache({
        request: req,
        cache: (caches as CacheStorage & { readonly default: Cache }).default,
        context: ctx,
        resolve: async () => handler.fetch(req),
      })
    )
  },
} satisfies ExportedHandler<Env>
