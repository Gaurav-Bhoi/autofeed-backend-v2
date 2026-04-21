import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { prettyJSON } from 'hono/pretty-json'
import { requestId } from 'hono/request-id'

type AppEnv = {
  Bindings: Env
}

const app = new Hono<AppEnv>()
const api = new Hono<AppEnv>()

app.use('*', requestId())
app.use('*', prettyJSON())

app.use('*', async (c, next) => {
  const startedAt = performance.now()

  try {
    await next()
  } finally {
    const durationMs = Number((performance.now() - startedAt).toFixed(2))

    console.log(
      JSON.stringify({
        message: 'request.complete',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
        colo: c.req.raw.cf?.colo ?? null,
      }),
    )
  }
})

app.get('/', (c) => {
  return c.json({
    ok: true,
    name: 'autofeed-backend-v2',
    runtime: 'cloudflare-workers',
    framework: 'hono',
    endpoints: {
      health: '/api/health',
    },
    requestId: c.get('requestId'),
  })
})

api.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'autofeed-backend-v2',
    timestamp: new Date().toISOString(),
    requestId: c.get('requestId'),
    cf: {
      colo: c.req.raw.cf?.colo ?? null,
      country: c.req.raw.cf?.country ?? null,
    },
  })
})

app.route('/api', api)

app.notFound((c) => {
  return c.json(
    {
      ok: false,
      error: 'Not Found',
      requestId: c.get('requestId'),
    },
    404,
  )
})

app.onError((err, c) => {
  const requestId = c.get('requestId')
  const status = err instanceof HTTPException ? err.status : 500

  console.error(
    JSON.stringify({
      message: 'request.error',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      error: err.message,
    }),
  )

  if (err instanceof HTTPException) {
    const response = err.getResponse()
    response.headers.set('X-Request-Id', requestId)
    return response
  }

  return c.json(
    {
      ok: false,
      error: 'Internal Server Error',
      requestId,
    },
    500,
  )
})

export { app }
export type AppType = typeof app

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
