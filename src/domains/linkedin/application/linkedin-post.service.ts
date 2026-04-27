import { badRequest, forbidden } from '../../../shared/http/errors'
import type {
  LinkedInCreatePostInput,
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

  async publish(
    accessToken: string,
    input: LinkedInPostInput,
    options?: {
      expectedLinkedInMemberId?: string
    },
  ) {
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

    if (input.imageUrl !== undefined) {
      this.assertUrl(input.imageUrl, 'imageUrl')
    }

    if (input.articleUrl !== undefined && input.imageUrl !== undefined) {
      throw badRequest('Only one of articleUrl or imageUrl can be attached')
    }

    if (input.visibility && !allowedVisibility.has(input.visibility)) {
      throw badRequest(
        'visibility must be one of PUBLIC, LOGGED_IN, CONNECTIONS, or CONTAINER',
      )
    }

    const profile = await this.gateway.getCurrentProfile(accessToken)

    if (
      options?.expectedLinkedInMemberId &&
      profile.id !== options.expectedLinkedInMemberId
    ) {
      throw forbidden(
        'Authorization token does not match the connected LinkedIn account',
      )
    }

    const postInput: LinkedInCreatePostInput = {
      text,
      visibility: input.visibility ?? 'PUBLIC',
    }

    if (input.imageUrl !== undefined) {
      const image = await this.gateway.uploadImage(
        accessToken,
        profile.authorUrn,
        {
          imageUrl: input.imageUrl,
        },
      )

      postInput.imageAssetUrn = image.asset
    } else if (input.articleUrl !== undefined) {
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

    const imageTitle = input.imageTitle?.trim()

    if (imageTitle) {
      postInput.imageTitle = imageTitle
    }

    const imageDescription = input.imageDescription?.trim()

    if (imageDescription) {
      postInput.imageDescription = imageDescription
    }

    const imageAltText = input.imageAltText?.trim()

    if (imageAltText) {
      postInput.imageAltText = imageAltText
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
