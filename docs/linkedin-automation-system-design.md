# Content Automation System Design

## Objective

Publish scheduled social content across modules such as LinkedIn and Instagram while keeping Neon and RunPod cost bounded even when retries, cron overlap, RunPod cold starts, or database outages happen.

## Scheduling Model

The Cloudflare Worker has one global scheduler:

- Global tick: `*/5 * * * *`.

The scheduler is module-aware. Each pending RunPod job owns its own cheap pending state key:

- LinkedIn example: `content:scheduler:runpod:pending:linkedin:{accountId}:{contentKeyOrRunPodJobId}`
- Instagram example: `content:scheduler:runpod:pending:instagram:{accountId}:{contentKeyOrRunPodJobId}`

There is still only one global 5-minute cron. If `n` modules have `m` pending posts, the scheduler stores `m` pending records and performs a bounded number of RunPod status checks per tick. Do not add `m` separate cron triggers.

Every tick must check cheap scheduler state before loading DB-backed services:

- If automation is `off`, return without touching Neon.
- If the tick is not a module's configured posting window and there is no pending state for that module, return without touching Neon or RunPod.
- If pending state exists, poll only those RunPod jobs for that module, up to the module's per-tick status-check limit.
- If RunPod is not terminal, update cheap pending state and return without touching Neon.
- If RunPod is terminal, load Neon, publish or mark failure, and clear pending state.
- If it is the configured posting window, load Neon and let that module create or resume exactly one job.

This gives fast RunPod completion checks without keeping Neon awake every five minutes.

Do not use in-memory timers such as `setTimeout` to resume work after the scheduled invocation ends. Cloudflare Workers are request scoped; an isolate can be stopped when the event finishes, so an in-memory counter is not a durable scheduler. Durable follow-up state must use Cloudflare KV, a Durable Object alarm, a Cloudflare Queue delay, or a provider callback.

`CONTENT_SCHEDULER_STATE` is the KV binding for cheap pending state. If that binding is missing, idle ticks still fail safe without touching Neon or RunPod, but five-minute pending-job polling is disabled until the binding is configured.

The same KV binding also stores short-lived dependency circuit state:

- `dependency:circuit:neon`
- `dependency:circuit:runpod`

If Neon or RunPod has a recent failure, modules that require that dependency skip downstream calls until the circuit TTL expires. The default TTLs are 15 minutes for Neon and 5 minutes for RunPod, configurable with `DEPENDENCY_NEON_BLOCK_TTL_SECONDS` and `DEPENDENCY_RUNPOD_BLOCK_TTL_SECONDS`.

Known outages can also be forced without waiting for the first failed request:

- `DEPENDENCY_NEON_FORCE_DOWN=true`
- `DEPENDENCY_RUNPOD_FORCE_DOWN=true`

Use the optional `DEPENDENCY_NEON_FORCE_DOWN_REASON` and `DEPENDENCY_RUNPOD_FORCE_DOWN_REASON` values to explain the outage in 503 responses and scheduler logs.

## Job Lifecycle

LinkedIn is the first implemented module, but every future module should follow the same lifecycle.

1. Resolve the publishable LinkedIn account.
2. Resume the oldest pending AI job for that account, if one exists.
3. Only if there is no pending job and the tick is the daily posting window, select a new content item.
4. Reserve the selected content in Postgres.
5. Atomically claim RunPod submission in Postgres.
6. Submit to RunPod only after the DB claim succeeds.
7. Save the RunPod job id immediately.
8. Store the RunPod job id in cheap scheduler state.
9. Poll RunPod within the current invocation for a bounded time.
10. If RunPod is still running, leave the cheap pending state so later 5-minute ticks can poll only RunPod.
11. When RunPod completes, parse the AI output, publish to LinkedIn, mark the job posted in Neon, and clear pending state.

## Safety Invariants

- No DB claim, no RunPod call.
- One RunPod submission per account per IST day.
- One global scheduler cron serves all modules; do not add a separate 5-minute cron per module.
- Module state keys must be isolated by module name, account, and job/content id.
- A content item with an existing RunPod job id must never be submitted again.
- A pending job blocks creation of a second daily job for the same account.
- If Neon is unavailable before submission, fail closed and do not call RunPod.
- If Neon is already marked down, do not load DB-backed services or call RunPod for modules that need Neon to complete.
- If Neon is unavailable after RunPod accepted a job, request RunPod cancellation.
- If RunPod is unavailable, record dependency failure and do not retry with another input mode in the same tick.
- If RunPod is already marked down, do not create new RunPod jobs and do not poll pending RunPod jobs until the circuit TTL expires.
- Production automation remains `off` until deliberately enabled.

## Cost Bounds

Neon Free is compute-hour based, not request-count based. The 5-minute scheduler may invoke the Worker 288 times per day, but idle ticks must only read cheap scheduler state. Neon is touched only when a module is due to create work or when a pending RunPod job reaches a terminal status.

RunPod cost is bounded by per-module and global daily submission caps. Polling an existing RunPod job may call RunPod status APIs, but it must not enqueue a second GPU job for the same module/account/day.

## Failure Handling

- Neon down before claim: return `dependency-unavailable`; no RunPod request is made.
- Neon circuit open: return 503 for user APIs or skip scheduled work before DB/RunPod calls.
- RunPod submit down: return `dependency-unavailable`; no alternate retry path is attempted.
- RunPod circuit open: return 503 for RunPod-backed user APIs or skip scheduled polling/submission.
- Neon down after RunPod submit: request RunPod cancellation and return `dependency-unavailable`.
- RunPod job pending: keep the saved job id in cheap scheduler state and poll on later 5-minute ticks.
- RunPod terminal failure: mark failed or move to the next input mode only through the persisted retry state.
- Daily limit reached: mark the job as blocked by `DAILY_LIMIT_REACHED`; do not submit.

## Adding A Module

To add Instagram or another module:

1. Register the module in the global scheduled handler.
2. Give the module its own pending-state prefix.
3. Keep the module's DB rows and idempotency keys separate from LinkedIn.
4. Use the shared RunPod service only after the module's DB claim succeeds.
5. Enforce both a module daily cap and the shared global RunPod budget cap.
6. Make module failures isolated so one module cannot block another during the same scheduler tick.

## Operational Runbook

When billing spikes or queue depth looks wrong:

1. Stop new GPU work first by setting automation to `stop` for the affected account/module or setting that module schedule to `off`.
2. Purge old RunPod queue items from the RunPod endpoint if there are unexpected queued jobs.
3. Check `linkedin_content_history` for rows from the current IST day with `runpod_attempt > 0` or a non-null `runpod_job_id`.
4. Confirm Cloudflare has one global cron trigger, `*/5 * * * *`, not one cron per module.
5. Confirm the latest deployment is receiving 100% traffic before assuming the guardrails are live.

## Future Hardening

- Bind `CONTENT_SCHEDULER_STATE` to Cloudflare KV in every deployed environment.
- Add a lightweight admin endpoint that reports today's RunPod submission count, oldest pending job per module, and automation status.
- Add alerting for RunPod queue length greater than expected, daily submission cap hits, and Neon dependency failures.
- Move pending-job completion to a per-job delayed queue, Durable Object alarm, or RunPod callback if global polling becomes too broad.
- Add integration tests around duplicate manual submissions, cron replay, DB outage before claim, and DB outage after RunPod submit.
