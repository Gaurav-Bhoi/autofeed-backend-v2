import type { ContentTemplateRepository } from '../domain/content-template.repository'

export class ListContentTemplatesService {
  constructor(private readonly repository: ContentTemplateRepository) {}

  async execute() {
    return this.repository.list()
  }
}
