import type { ContentTemplate } from '../domain/content-template.entity'
import type { ContentTemplateRepository } from '../domain/content-template.repository'

const templates: ContentTemplate[] = [
  {
    id: 'linkedin-thought-leadership',
    title: 'Thought Leadership',
    description:
      'A narrative template for founder or executive insights with a strong point of view.',
    objective: 'Build trust and authority',
    channel: 'linkedin',
  },
  {
    id: 'case-study-breakdown',
    title: 'Case Study Breakdown',
    description:
      'A structured format for turning a project or client win into a repeatable story.',
    objective: 'Demonstrate outcomes',
    channel: 'multi-channel',
  },
  {
    id: 'product-launch-teaser',
    title: 'Product Launch Teaser',
    description:
      'A hook-driven content pattern for shipping updates, launches, and release notes.',
    objective: 'Drive awareness and clicks',
    channel: 'linkedin',
  },
]

export class InMemoryContentTemplateRepository
  implements ContentTemplateRepository
{
  async list() {
    return templates
  }
}
