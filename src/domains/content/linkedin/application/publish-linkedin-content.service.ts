import type {
  LinkedInPostInput,
  LinkedInPublishedPost,
  LinkedInVisibility,
} from '../../../linkedin/domain/linkedin.entities'
import { CreateLinkedInContentService } from './create-linkedin-content.service'
import type {
  LinkedInContentDraft,
  LinkedInContentInput,
} from '../domain/linkedin-content.entity'

export type LinkedInContentPublishInput = LinkedInContentInput & {
  articleUrl?: string
  articleTitle?: string
  articleDescription?: string
  imageUrl?: string
  imageTitle?: string
  imageDescription?: string
  imageAltText?: string
  visibility?: LinkedInVisibility
}

export type LinkedInContentPublishResult = {
  draft: LinkedInContentDraft
  post: LinkedInPublishedPost
}

export interface LinkedInContentPublisher {
  publish(
    accessToken: string,
    input: LinkedInPostInput,
    options?: {
      expectedLinkedInMemberId?: string
    },
  ): Promise<LinkedInPublishedPost>
}

export class PublishLinkedInContentService {
  constructor(
    private readonly contentService: CreateLinkedInContentService,
    private readonly publisher: LinkedInContentPublisher,
  ) {}

  async publish(
    accessToken: string,
    input: LinkedInContentPublishInput,
    options?: {
      expectedLinkedInMemberId?: string
    },
  ): Promise<LinkedInContentPublishResult> {
    const draft = this.contentService.execute(input)
    const postInput: LinkedInPostInput = {
      text: draft.text,
    }

    if (input.articleUrl !== undefined) {
      postInput.articleUrl = input.articleUrl
    }

    if (input.articleTitle !== undefined) {
      postInput.articleTitle = input.articleTitle
    }

    if (input.articleDescription !== undefined) {
      postInput.articleDescription = input.articleDescription
    }

    if (input.imageUrl !== undefined) {
      postInput.imageUrl = input.imageUrl
    }

    if (input.imageTitle !== undefined) {
      postInput.imageTitle = input.imageTitle
    }

    if (input.imageDescription !== undefined) {
      postInput.imageDescription = input.imageDescription
    }

    if (input.imageAltText !== undefined) {
      postInput.imageAltText = input.imageAltText
    }

    if (input.visibility !== undefined) {
      postInput.visibility = input.visibility
    }

    const post = await this.publisher.publish(accessToken, postInput, options)

    return {
      draft,
      post,
    }
  }
}
