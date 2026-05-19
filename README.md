# autofeed-backend-v2

A Cloudflare Worker API built with Hono, now organized around domain-driven boundaries.

## Architecture

The backend is split into two domains:

- `linkedin`: OAuth login, callback handling, profile lookup, and post publishing
- `content`: content planning templates and platform-specific content workflows

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
- `GET /api/linkedin/dashboard`: return the connected LinkedIn account for the authenticated Autofeed session
- `GET /api/linkedin/authorization-url`: JSON-first alias that returns the authorization URL payload
- `GET /api/linkedin/authorizationUrl`: legacy camelCase alias for the authorization URL payload
- `GET /linkedin/authorizationCallback`: exchange the LinkedIn auth code, persist the LinkedIn account in Postgres, and return an HTML success page for browser navigations or JSON for API callers
- `GET /api/linkedin/profile`: fetch the authenticated LinkedIn member profile using `Authorization: Bearer <autofeed-session-token>` or a legacy LinkedIn access token
- `POST /api/linkedin/posts`: publish a LinkedIn UGC post using `Authorization: Bearer <autofeed-session-token>` or a legacy LinkedIn access token

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

For native image posts, use `imageUrl` instead of `articleUrl`. The Worker fetches the image, uploads it to LinkedIn, and attaches the returned media asset to the post.

### Content domain

- `GET /api/content`: content domain overview
- `GET /api/content/templates`: list built-in content templates
- `GET /api/content/linkedin`: LinkedIn content subdomain overview
- `GET /api/content/linkedin/status`: validate whether the authenticated Autofeed session's LinkedIn account is connected, token-active, and allowed to publish
- `GET /api/content/linkedin/automation`: return the current LinkedIn automation status for the authenticated Autofeed session
- `POST /api/content/linkedin/automation/status`: set automation to `start` or `stop` using `Authorization: Bearer <autofeed-session-token>`
- `POST /api/content/linkedin/automation/start`: start automation using `Authorization: Bearer <autofeed-session-token>`
- `POST /api/content/linkedin/automation/stop`: stop automation using `Authorization: Bearer <autofeed-session-token>`
- `POST /api/content/linkedin/drafts`: create LinkedIn-ready post content from a topic, objective, audience, and key points
- `POST /api/content/linkedin/posts`: create LinkedIn-ready content and publish it using `Authorization: Bearer <autofeed-session-token>`
- `POST /api/content/linkedin/posts/single`: create one AI-assisted image post using RunPod and publish it using `Authorization: Bearer <autofeed-session-token>`

Example LinkedIn content draft body:

```json
{
  "topic": "AI-assisted content operations",
  "audience": "B2B founders",
  "objective": "show how repeatable workflows improve publishing consistency",
  "keyPoints": [
    "Separate content planning from channel-specific creation",
    "Generate the post only when the publish workflow is ready",
    "Keep the LinkedIn post concise and practical"
  ],
  "tone": "professional",
  "callToAction": "What part of your content workflow still feels too manual?"
}
```

`POST /api/content/linkedin/posts` accepts the same content fields plus optional `accountId`, `linkedinMemberId`, `articleUrl`, `articleTitle`, `articleDescription`, `imageUrl`, `imageTitle`, `imageDescription`, `imageAltText`, and `visibility`. The content subdomain validates the Autofeed session, confirms that the requested account matches that session, checks that the saved LinkedIn token is active, verifies `w_member_social`, and publishes with the server-held LinkedIn token.

`POST /api/content/linkedin/posts/single` bypasses the automation `start`/`stop` flag and publishes one image-based post immediately. If `imageUrl` is provided, that image is sent to RunPod and then posted to LinkedIn. If `imageUrl` is omitted, the backend chooses a random unused image from the configured content engine sections, such as `tech-memes` or `news`. The alias `POST /api/content/linkedin/single-post` is also available.

Example single AI post using a caller-provided image:

```json
{
  "imageUrl": "https://example.com/demo.png",
  "topic": "Deploying on Friday",
  "sourceUrl": "https://example.com/demo",
  "visibility": "PUBLIC"
}
```

Example single AI post using a backend-selected image:

```json
{
  "section": "tech-memes"
}
```

If RunPod is still processing after the request wait window, the endpoint returns `202` with `posted: false`, `reason: "runpod-job-pending"`, and the RunPod job id. Calling the same endpoint again without `forceNew` will resume the pending job for that LinkedIn account before selecting another image.

Example automation status body:

```json
{
  "status": "start"
}
```

Automation accepts only `start` and `stop`. Starting or stopping automation requires an Autofeed session token for the LinkedIn account, validates the saved token expiry, checks `w_member_social`, and verifies that the saved LinkedIn token still belongs to that LinkedIn member. The frontend should not store or send LinkedIn access tokens for automation.

### LinkedIn scheduled publishing

The Worker also has a module-aware scheduled handler for automatic social publishing from the content domain. A single global cron runs every five minutes, but idle ticks only check cheap scheduler state; they do not touch Neon or RunPod unless a module is due to create work or has pending RunPod jobs. Pending state is keyed by module, account, and job/content id so future modules can track multiple posts without separate cron triggers. The detailed safety design is documented in [docs/linkedin-automation-system-design.md](docs/linkedin-automation-system-design.md). New LinkedIn content is created only at configured posting windows:

- `daily-10am`: publishes at 10:00 AM Asia/Kolkata (`04:30` UTC)
- `every-18-hours`: publishes every 18 hours, anchored from 10:00 AM Asia/Kolkata
- `off`: skips automatic publishing

Development is configured with `CONTENT_LINKEDIN_AUTO_POST_SCHEDULE=daily-10am`. Production is configured as `off` until automatic posting is intentionally enabled there.

Scheduled posting uses the most recently connected LinkedIn account by default. Set `CONTENT_LINKEDIN_AUTO_POST_ACCOUNT_ID` or `CONTENT_LINKEDIN_AUTO_POST_MEMBER_ID` to target a specific saved LinkedIn account. Before posting, the scheduler validates that the account exists, automation is set to `start`, has a bearer access token, has not expired, and includes the `w_member_social` posting scope.

At each eligible posting window, the scheduler asks the LinkedIn content engine to choose a random section, then a random unused item inside that section. Used content keys are stored in Postgres so the Worker does not repeat a previously posted meme/news image after restarts or future cron invocations.

Built-in image sources:

- `tech-memes`: prefers highly scored weekly image posts from meme-focused subreddits and falls back to generated Memegen images only when Reddit has no usable unused meme
- `news`: chooses a random broad-news subreddit, reads its daily top JSON feed, and renders the selected story into a square editorial PNG card with a source image, bold headline, highlighted keywords, and a black lower panel. `tech-news` remains accepted as a legacy alias.

After an image is selected, the scheduler submits it to the configured RunPod Serverless endpoint only after an atomic Postgres claim succeeds. If the endpoint is warm, the same invocation may receive the AI result and publish immediately. If RunPod is cold-starting, downloading models, or still processing, the job id is stored in scheduler state and later five-minute ticks poll `/status/{job_id}` without touching Neon until RunPod reaches a terminal status. The AI response must be JSON with `caption`, `post_content`, and `hashtags`; those fields are composed into the final LinkedIn text and posted with the selected image.

Scheduled content engine vars:

- `CONTENT_LINKEDIN_AUTO_POST_SECTIONS`: optional `|` or comma-separated section allow-list, for example `tech-memes|news`
- `CONTENT_LINKEDIN_MEME_SUBREDDITS`: optional `|` or comma-separated subreddit allow-list for `tech-memes` Reddit sources
- `CONTENT_LINKEDIN_REDDIT_SUBREDDITS`: optional `|` or comma-separated subreddit allow-list for broad news
- `CONTENT_LINKEDIN_REDDIT_USER_AGENT`: Reddit API user agent, for example `script:linkedin-news:v1.0 (by /u/YOUR_REDDIT_USERNAME)`
- `CONTENT_LINKEDIN_RUNPOD_ENDPOINT_ID`: RunPod endpoint id, defaulting to `qexf1iafzz41nh`
- `CONTENT_LINKEDIN_RUNPOD_MODEL`: RunPod chat model, defaulting to `Qwen2.5-VL-32B-Instruct`
- `CONTENT_LINKEDIN_RUNPOD_POLL_TIMEOUT_MS`: how long each cron tick waits for RunPod before leaving the job pending
- `CONTENT_LINKEDIN_RUNPOD_POLL_INTERVAL_MS`: status polling interval during that wait window
- `CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL`: optional JSON array of content items
- `CONTENT_LINKEDIN_AUTO_POST_VISIBILITY`: optional default LinkedIn visibility for selected items
- `CONTENT_SCHEDULER_STATE`: optional Cloudflare KV binding used for cheap pending RunPod job state between five-minute scheduler ticks
- `CONTENT_SCHEDULER_PENDING_TTL_SECONDS`: optional pending-state TTL, defaulting to 172800 seconds

`RUNPOD_API_KEY` must be configured as a Worker secret. Do not put the RunPod bearer token in `wrangler.jsonc` or source files. `CONTENT_SCHEDULER_STATE` should be bound to a Cloudflare KV namespace to enable five-minute pending-job polling; without it, idle ticks still no-op safely but pending jobs are not resumed by the cheap scheduler state.

Default meme subreddits are `r/ProgrammerHumor`, `r/programmingmemes`, `r/ProgrammerDadJokes`, `r/programmerreactions`, `r/linuxmemes`, `r/webdevmemes`, `r/sysadminhumor`, `r/iiiiiiitttttttttttt`, and `r/softwaregore`. Reddit-sourced meme posts include the source subreddit in the RunPod prompt so the final LinkedIn text can mention the channel naturally.

Default news subreddits are `r/worldnews`, `r/news`, `r/geopolitics`, `r/india`, `r/IndianPolitics`, `r/IndianModerate`, `r/unitedstatesofindia`, `r/business`, `r/economics`, `r/technology`, `r/science`, and `r/UpliftingNews`.

Each `CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL` item supports `section`, `id`, `topic`, `audience`, `objective`, `keyPoints`, `tone`, `callToAction`, `imageUrl`, `imageTitle`, `imageDescription`, `imageAltText`, `articleUrl`, `articleTitle`, `articleDescription`, `sourceUrl`, and `visibility`. Use custom pool items for future sections or curated fallback content; built-in `tech-memes` and `news` already use the live APIs above.

Example pool item:

```json
{
  "section": "tech-memes",
  "id": "ci-said-no",
  "topic": "When the code works locally but CI has different standards",
  "keyPoints": ["Local success is not the same as repeatable delivery"],
  "tone": "conversational",
  "imageUrl": "https://example.com/memes/ci-said-no.png",
  "imageTitle": "Works on my machine"
}
```

## Environments

- `development`: route `dev-api.autofeed.io/*` with LinkedIn OAuth vars, `DATABASE_URL`, `AUTOFEED_SESSION_SECRET`, and required local secrets
- `production`: route `api.autofeed.io/*` with production LinkedIn OAuth vars, `DATABASE_URL`, `AUTOFEED_SESSION_SECRET`, and required secrets

## Database Persistence

- Successful LinkedIn callbacks are upserted into a `linkedin_accounts` table in Neon/Postgres through Prisma ORM.
- The table stores the LinkedIn member id, profile fields, token metadata, scope data, token expiry timestamps, last login metadata, and a `login_count`. Newly saved LinkedIn access, refresh, and ID tokens are encrypted before persistence; existing plaintext rows continue to be readable until the user reconnects.
- Accounts are deduplicated by `linkedin_member_id`, so repeat logins refresh the saved record instead of creating duplicates.
- Automated content is recorded in `linkedin_content_history` by content key, section, item id, source URL, image URL, RunPod job status/output, LinkedIn post id, account id, and publish time so scheduled image selections are not repeated and async AI jobs can resume after cold starts.
- The schema is defined in [prisma/schema.prisma](./prisma/schema.prisma) and should be applied with `npm run prisma:db:push`.
- `GET /api/linkedin/dashboard` reads from this table and returns the most recent connected account by default.
- `GET /api/linkedin/dashboard?accountId=...` and `GET /api/linkedin/dashboard?linkedinMemberId=...` are supported for future user-specific lookups.

## LinkedIn OAuth Redirect

- Frontend should start the LinkedIn OAuth flow through `/api/linkedin/auth-start` or `/api/linkedin/connect` so the backend can create a signed state value and complete the server-side token exchange.
- Development callback URL: `https://dev-api.autofeed.io/linkedin/authorizationCallback`
- Development native return URI: `com.autofeed.dev.linkedin://oauthredirect`
- Register `https://api.autofeed.io/linkedin/authorizationCallback` in the LinkedIn app for production.
- Browser navigations to `/api/linkedin/auth-start`, `/api/linkedin/login`, and `/api/linkedin/connect` redirect to LinkedIn by default.
- API-style requests return JSON by default, and `?redirect=true` or `?redirect=false` can still force the behavior either way.
- `/api/linkedin/authorization-url` and `/api/linkedin/authorizationUrl` always lean JSON-first unless `?redirect=true` is passed explicitly.
- Browser navigations back to `/linkedin/authorizationCallback` render a success or error page instead of raw JSON.
- Add `?format=json` to `/linkedin/authorizationCallback` if you need the JSON callback payload for debugging or API use.
- Callback JSON returns `session.accessToken`, an Autofeed account session token. It does not return raw LinkedIn access or refresh tokens.
- Native clients can pass `returnUri` or `redirectUri` to auth start, for example `com.autofeed.linkedin://oauthredirect` or the development app URI above. After successful callback, the backend redirects to that URI with `autofeedSessionToken`, `autofeedSessionExpiresAt`, `accountId`, and `linkedinMemberId` in the URL fragment.
- Allowed native return URIs default to `com.autofeed.linkedin://oauthredirect` and `autofeed://linkedin/oauthredirect`. Set `LINKEDIN_ALLOWED_RETURN_URIS` to add exact allowed return URIs.
- The default LinkedIn login request asks for `openid`, `profile`, `email`, and `w_member_social` so connected accounts can publish after LinkedIn grants the posting permission.
- `DATABASE_URL` must be set as a Worker secret before LinkedIn callback completion can persist accounts.
- Set `AUTOFEED_SESSION_SECRET` as a Worker secret in production. If it is missing, the Worker falls back to `LINKEDIN_CLIENT_SECRET` for compatibility, but a separate session secret is recommended.
- `ALLOWED_ORIGINS` can be set to a comma, pipe, or whitespace separated list of browser origins allowed by CORS. Defaults include `https://autofeed.io`, `https://www.autofeed.io`, `http://localhost:3000`, and `http://localhost:5173`.
- Prisma CLI commands also need `DATABASE_URL` in the local shell environment because Cloudflare Worker secrets are not visible to the CLI.

## Notes

- The Worker uses module syntax and exports an explicit `fetch` handler for Cloudflare Workers.
- Request IDs are attached to responses and preserved in structured logs.
- Logs are emitted as structured JSON for easier Workers Observability filtering.
- `wrangler.jsonc` enables Workers Observability with full request sampling.
