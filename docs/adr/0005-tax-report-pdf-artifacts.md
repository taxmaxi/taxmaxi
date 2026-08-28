# Tax reports are stored PDF artifacts rendered from HTML by Cloudflare Browser Rendering

## Status

Proposed

## Context

The tax report PDF is a core product output for the API, the CLI, and the web app. It must carry the right numbers for a German tax filing, look good, and be exactly reproducible when a person later asks "what did I file?". The report design should reuse the web app's styling stack (React and Tailwind) so one template serves design iteration in the browser and production rendering on the server.

A tax report is account-level: one account, one jurisdiction, one tax year, across all of the account's source connections. Holding periods and FIFO span sources, so a per-source tax number is wrong for anyone with more than one source.

## Decision

- A report generation is an async worker job. The API accepts a generation request, refuses it immediately when a report blocker (such as `fifo_inventory_shortfall`) exists, and otherwise queues it.
- The report template is a pure React component with build-time-compiled Tailwind CSS in `packages/report-template`. It is a function of a typed `ReportData` value and does no fetching.
- The worker renders the template to an HTML string and sends it to Cloudflare Browser Rendering's REST `/pdf` endpoint. No Chromium runs on our servers. Page furniture (page numbers) comes from the endpoint's header/footer templates.
- The resulting PDF is an unchangeable artifact stored as bytes in Postgres, stamped with its generation time. Every generation is kept. Account deletion removes reports by cascade.
- Reports never generate from numbers known to be broken. Blockers stop generation; there is no "disclose and generate anyway" mode.

## Considered options

- **PDF libraries (`@react-pdf/renderer`, pdfkit, LaTeX/Typst)**: rejected because they cannot reuse the web app's HTML/Tailwind stack, so the design loop would split in two.
- **Self-hosted Puppeteer/Playwright on Hetzner**: works, but means running and patching Chromium ourselves. Browser Rendering accepts raw HTML over REST, so the server never needs a browser.
- **Browser `window.print()` as the product path**: only exists for a human in the web app; the API and CLI need bytes. Browser print remains a dev-only design iteration tool on a fixture route.
- **Cloudflare R2 for the bytes**: rejected for now. Postgres gives one-transaction writes, cascade deletes, and reuse of the existing test setup. Report PDFs are a few hundred KB; R2 becomes worth a second system only at much higher volume, and the repository contract hides the storage choice.
- **Disclose-and-generate for FIFO shortfalls** (as some competitors do, booking missing inventory at zero cost): rejected. A report that silently absorbs broken data undermines trust in every other number on it.

## Consequences

- Cloudflare controls the Chromium version, so regenerating a report later may not produce byte-identical output. Storing every generated PDF is what makes reports reproducible, not re-rendering.
- Report generation depends on an external service. Its limits (60s render timeout, request rates) are why the report stays summary-level, with no per-transaction appendix.
- The calculation is not a tax engine. German rules are hardcoded constants and branches with cited sources; the report row records the rule values it was generated under so a future rules system can tell old artifacts apart.
