import { Hono } from 'hono'

import type { AppEnv } from '../../../app/types'
import { ListContentTemplatesService } from '../application/list-content-templates.service'
import { InMemoryContentTemplateRepository } from '../infrastructure/in-memory-content-template.repository'
import { createLinkedInContentRouter } from '../linkedin/presentation/linkedin-content.routes'

export function createContentRouter() {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    return c.json({
      ok: true,
      domain: 'content',
      description: 'Content planning and template domain',
      endpoints: {
        templates: '/api/content/templates',
        linkedin: '/api/content/linkedin',
        linkedinStatus: '/api/content/linkedin/status',
        linkedinAutomation: '/api/content/linkedin/automation',
        linkedinAutomationStatus: '/api/content/linkedin/automation/status',
        linkedinAutomationStart: '/api/content/linkedin/automation/start',
        linkedinAutomationStop: '/api/content/linkedin/automation/stop',
        linkedinDrafts: '/api/content/linkedin/drafts',
        linkedinPosts: '/api/content/linkedin/posts',
        linkedinSingleAiPost: '/api/content/linkedin/posts/single',
        linkedinNewsCardImage: '/api/content/linkedin/news-card.png',
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

  router.route('/linkedin', createLinkedInContentRouter())

  return router
}
