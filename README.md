# autofeed-backend-v2

A clean Cloudflare Worker API built with Hono and managed by Wrangler.

## What this project is

- `src/index.ts`: the Worker entrypoint and Hono app
- `wrangler.jsonc`: the source of truth for Worker configuration
- `worker-configuration.d.ts`: generated Cloudflare runtime and binding types

## Scripts

- `npm run dev`: start the local Worker on Wrangler's dev server
- `npm run typegen`: regenerate Worker runtime and `Env` types from `wrangler.jsonc`
- `npm run typecheck`: run TypeScript in strict no-emit mode
- `npm run check`: regenerate types and run the full type check
- `npm run deploy`: deploy the Worker with Wrangler

## Routes

- `GET /`: basic service metadata and available endpoints
- `GET /api/health`: health payload with request id and Cloudflare request metadata when available

## Notes

- The Worker uses module syntax and exports an explicit `fetch` handler for Cloudflare Workers.
- Request IDs are attached to every response via `X-Request-Id`.
- Logs are emitted as structured JSON so they are easier to filter in Workers Observability.
- `wrangler.jsonc` enables Workers Observability with full request sampling.
