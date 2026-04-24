import { Hono } from 'hono'

import { createContentRouter } from '../domains/content/presentation/content.routes'
import { createLinkedInRouter } from '../domains/linkedin/presentation/linkedin.routes'
import type { AppEnv } from './types'

export function createApiRouter() {
  const api = new Hono<AppEnv>()

  api.get('/health', (c) => {
    return c.json({
      ok: true,
      service: 'autofeed-backend',
      architecture: 'domain-driven',
      domains: ['linkedin', 'content'],
      timestamp: new Date().toISOString(),
      requestId: c.get('requestId'),
      cf: {
        colo: c.req.raw.cf?.colo ?? null,
        country: c.req.raw.cf?.country ?? null,
      },
    })
  })

  api.route('/linkedin', createLinkedInRouter())
  api.route('/content', createContentRouter())

  return api
}
