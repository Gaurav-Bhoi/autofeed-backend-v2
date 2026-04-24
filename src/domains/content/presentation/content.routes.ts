import { Hono } from 'hono'

import type { AppEnv } from '../../../app/types'
import { ListContentTemplatesService } from '../application/list-content-templates.service'
import { InMemoryContentTemplateRepository } from '../infrastructure/in-memory-content-template.repository'

export function createContentRouter() {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    return c.json({
      ok: true,
      domain: 'content',
      description: 'Content planning and template domain',
      endpoints: {
        templates: '/api/content/templates',
      },
      requestId: c.get('requestId'),
    })
  })

  router.get('/templates', async (c) => {
    const repository = new InMemoryContentTemplateRepository()
    const service = new ListContentTemplatesService(repository)
    const templates = await service.execute()

    return c.json({
      ok: true,
      domain: 'content',
      templates,
      requestId: c.get('requestId'),
    })
  })

  return router
}
