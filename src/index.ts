import { createApp } from './app/create-app'

const app = createApp()

export { app }
export type AppType = typeof app

export default {
  async fetch(request, env, ctx) {
    try {
      return await app.fetch(request, env, ctx)
    } catch (error) {
      const requestId = crypto.randomUUID()
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Unhandled Worker exception'

      console.error(
        JSON.stringify({
          message: 'worker.fetch.unhandled_error',
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: message,
        }),
      )

      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Internal Server Error',
          requestId,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
            'Access-Control-Expose-Headers': 'X-Request-Id',
            'X-Request-Id': requestId,
          },
        },
      )
    }
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller, env))
  },
} satisfies ExportedHandler<Env>

async function handleScheduled(controller: ScheduledController, env: Env) {
  const { handleScheduledContent } = await import(
    './domains/content/scheduling/content-scheduled.handler'
  )

  await handleScheduledContent(controller, env)
}
