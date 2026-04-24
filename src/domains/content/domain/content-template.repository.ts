import type { ContentTemplate } from './content-template.entity'

export interface ContentTemplateRepository {
  list(): Promise<ContentTemplate[]>
}
