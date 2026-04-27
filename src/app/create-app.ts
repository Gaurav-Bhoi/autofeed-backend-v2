import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { prettyJSON } from 'hono/pretty-json'
import { requestId } from 'hono/request-id'

import { LINKEDIN_CALLBACK_PATH } from '../domains/linkedin/linkedin.constants'
import { handleLinkedInCallback } from '../domains/linkedin/presentation/linkedin.routes'
import { createApiRouter } from './create-api-router'
import type { AppEnv } from './types'

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use('*', requestId())
  app.use('*', prettyJSON())
  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin || '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: [
        'Accept',
        'Authorization',
        'Content-Type',
        'X-App-Environment',
        'X-Requested-With',
      ],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  )

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
      name: 'autofeed-backend',
      runtime: 'cloudflare-workers',
      framework: 'hono',
      architecture: 'domain-driven',
      domains: {
        linkedin: '/api/linkedin',
        content: '/api/content',
      },
      endpoints: {
        health: '/api/health',
        linkedinAuthStart: '/api/linkedin/auth-start',
        linkedinConnect: '/api/linkedin/connect',
        linkedinDashboard: '/api/linkedin/dashboard',
        linkedinAuthorizationUrl: '/api/linkedin/authorization-url',
        linkedinAuthorizationCallback: LINKEDIN_CALLBACK_PATH,
        linkedinProfile: '/api/linkedin/profile',
        linkedinPost: '/api/linkedin/posts',
        contentTemplates: '/api/content/templates',
        contentLinkedIn: '/api/content/linkedin',
        contentLinkedInStatus: '/api/content/linkedin/status',
        contentLinkedInAutomation: '/api/content/linkedin/automation',
        contentLinkedInAutomationStatus: '/api/content/linkedin/automation/status',
        contentLinkedInAutomationStart: '/api/content/linkedin/automation/start',
        contentLinkedInAutomationStop: '/api/content/linkedin/automation/stop',
        contentLinkedInDrafts: '/api/content/linkedin/drafts',
        contentLinkedInPosts: '/api/content/linkedin/posts',
        contentLinkedInSingleAiPost: '/api/content/linkedin/posts/single',
        contentLinkedInNewsCardImage: '/api/content/linkedin/news-card.png',
      },
      requestId: c.get('requestId'),
    })
  })

  app.route('/api', createApiRouter())

  app.get(LINKEDIN_CALLBACK_PATH, handleLinkedInCallback)

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
      const response = c.json(
        {
          ok: false,
          error: err.message,
          requestId,
        },
        err.status,
      )

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

  return app
}
