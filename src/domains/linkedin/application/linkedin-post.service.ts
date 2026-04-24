import { badRequest } from '../../../shared/http/errors'
import type {
  LinkedInPostInput,
  LinkedInVisibility,
} from '../domain/linkedin.entities'
import type { LinkedInGateway } from '../domain/linkedin.gateway'

const allowedVisibility = new Set<LinkedInVisibility>([
  'PUBLIC',
  'LOGGED_IN',
  'CONNECTIONS',
  'CONTAINER',
])

export class LinkedInPostService {
  constructor(private readonly gateway: LinkedInGateway) {}

  async publish(accessToken: string, input: LinkedInPostInput) {
    if (!accessToken.trim()) {
      throw badRequest('LinkedIn access token is required')
    }

    const text = input.text.trim()

    if (!text) {
      throw badRequest('Post text is required')
    }

    if (text.length > 3000) {
      throw badRequest('Post text must be 3000 characters or fewer')
    }

    if (input.articleUrl !== undefined) {
      this.assertUrl(input.articleUrl, 'articleUrl')
    }

    if (input.visibility && !allowedVisibility.has(input.visibility)) {
      throw badRequest(
        'visibility must be one of PUBLIC, LOGGED_IN, CONNECTIONS, or CONTAINER',
      )
    }

    const profile = await this.gateway.getCurrentProfile(accessToken)
    const postInput: LinkedInPostInput = {
      text,
      visibility: input.visibility ?? 'PUBLIC',
    }

    if (input.articleUrl !== undefined) {
      postInput.articleUrl = input.articleUrl
    }

    const articleTitle = input.articleTitle?.trim()

    if (articleTitle) {
      postInput.articleTitle = articleTitle
    }

    const articleDescription = input.articleDescription?.trim()

    if (articleDescription) {
      postInput.articleDescription = articleDescription
    }

    return this.gateway.createPost(accessToken, profile.authorUrn, postInput)
  }

  private assertUrl(value: string, fieldName: string) {
    try {
      new URL(value)
    } catch {
      throw badRequest(`${fieldName} must be a valid absolute URL`)
    }
  }
}
