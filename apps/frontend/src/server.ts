import "../instrument.server.mjs"

import handler from "@tanstack/react-start/server-entry"

export default {
  fetch: handler.fetch,
}
