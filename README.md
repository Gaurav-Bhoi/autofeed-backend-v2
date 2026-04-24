# autofeed-backend-v2

A Cloudflare Worker API built with Hono, now organized around domain-driven boundaries.

## Architecture

The backend is split into two domains:

- `linkedin`: OAuth login, callback handling, profile lookup, and post publishing
- `content`: content planning templates and future content workflows

Each domain follows the same structure:

- `domain`: core entities and ports
- `application`: use cases and orchestration services
- `infrastructure`: external adapters such as HTTP clients or repositories
- `presentation`: Hono routes and HTTP request handling

The app bootstrap lives in `src/app`, while shared HTTP helpers live in `src/shared`.

Database persistence is implemented with Prisma ORM, while the application and presentation layers continue talking to repository interfaces instead of ORM types directly.

## Scripts

- `npm run dev`: start the local Worker with the `development` Wrangler environment
- `npm run prisma:generate`: generate the Prisma Client into `src/generated/prisma`
- `npm run prisma:db:push`: push the Prisma schema to the configured PostgreSQL database
- `npm run typegen`: regenerate Worker runtime and `Env` types from `wrangler.jsonc`
- `npm run typecheck`: run TypeScript in strict no-emit mode
- `npm run check`: regenerate Prisma Client and Worker types, then run the full type check
- `npm run deploy`: deploy the Worker with the `production` Wrangler environment
- `npm run deploy:development`: deploy the Worker with the `development` Wrangler environment
- `npm run deploy:production`: deploy the Worker with the `production` Wrangler environment

## Routes

- `GET /`: service metadata, architecture, and main endpoint map
- `GET /api/health`: worker health and Cloudflare request metadata

### LinkedIn domain

- `GET /api/linkedin`: LinkedIn domain overview
- `GET /api/linkedin/auth-start`: start the LinkedIn OAuth flow
- `GET /api/linkedin/login`: compatibility alias for starting the LinkedIn OAuth flow
- `GET /api/linkedin/connect`: compatibility alias for starting the LinkedIn OAuth flow
- `GET /api/linkedin/dashboard`: return whether a LinkedIn account is already connected and, if so, a safe account summary for the landing page
- `GET /api/linkedin/authorization-url`: JSON-first alias that returns the authorization URL payload
- `GET /api/linkedin/authorizationUrl`: legacy camelCase alias for the authorization URL payload
- `GET /linkedin/authorizationCallback`: exchange the LinkedIn auth code, persist the LinkedIn account in Postgres, and return an HTML success page for browser navigations or JSON for API callers
- `GET /api/linkedin/profile`: fetch the authenticated LinkedIn member profile using `Authorization: Bearer <token>`
- `POST /api/linkedin/posts`: publish a LinkedIn UGC post using `Authorization: Bearer <token>`

Example post body:

```json
{
  "text": "We just shipped a new version of Autofeed.",
  "articleUrl": "https://autofeed.io/blog/new-release",
  "articleTitle": "Autofeed Release Notes",
  "articleDescription": "A quick look at the newest backend improvements.",
  "visibility": "PUBLIC"
}
```

### Content domain

- `GET /api/content`: content domain overview
- `GET /api/content/templates`: list built-in content templates

## Environments

- `development`: route `dev-api.autofeed.io/*` with LinkedIn OAuth vars, `DATABASE_URL`, and required local secrets
- `production`: route `api.autofeed.io/*` with the production LinkedIn OAuth vars, `DATABASE_URL`, and required secret

## Database Persistence

- Successful LinkedIn callbacks are upserted into a `linkedin_accounts` table in Neon/Postgres through Prisma ORM.
- The table stores the LinkedIn member id, profile fields, tokens, scope data, token expiry timestamps, last login metadata, and a `login_count`.
- Accounts are deduplicated by `linkedin_member_id`, so repeat logins refresh the saved record instead of creating duplicates.
- The schema is defined in [prisma/schema.prisma](./prisma/schema.prisma) and should be applied with `npm run prisma:db:push`.
- `GET /api/linkedin/dashboard` reads from this table and returns the most recent connected account by default.
- `GET /api/linkedin/dashboard?accountId=...` and `GET /api/linkedin/dashboard?linkedinMemberId=...` are supported for future user-specific lookups.

## LinkedIn OAuth Redirect

- Frontend can start the LinkedIn OAuth flow either by opening `/api/linkedin/auth-start` or by building the LinkedIn URL itself with the backend callback URL as the `redirect_uri`.
- Development callback URL: `https://dev-api.autofeed.io/linkedin/authorizationCallback`
- Register `https://api.autofeed.io/linkedin/authorizationCallback` in the LinkedIn app for production.
- Browser navigations to `/api/linkedin/auth-start`, `/api/linkedin/login`, and `/api/linkedin/connect` redirect to LinkedIn by default.
- API-style requests return JSON by default, and `?redirect=true` or `?redirect=false` can still force the behavior either way.
- `/api/linkedin/authorization-url` and `/api/linkedin/authorizationUrl` always lean JSON-first unless `?redirect=true` is passed explicitly.
- Browser navigations back to `/linkedin/authorizationCallback` render a success or error page instead of raw JSON.
- Add `?format=json` to `/linkedin/authorizationCallback` if you need the raw callback payload for debugging or API use.
- `DATABASE_URL` must be set as a Worker secret before LinkedIn callback completion can persist accounts.
- Prisma CLI commands also need `DATABASE_URL` in the local shell environment because Cloudflare Worker secrets are not visible to the CLI.

## Notes

- The Worker uses module syntax and exports an explicit `fetch` handler for Cloudflare Workers.
- Request IDs are attached to responses and preserved in structured logs.
- Logs are emitted as structured JSON for easier Workers Observability filtering.
- `wrangler.jsonc` enables Workers Observability with full request sampling.
