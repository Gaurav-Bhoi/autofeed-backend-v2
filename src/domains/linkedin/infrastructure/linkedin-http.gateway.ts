import { badGateway, serviceUnavailable } from '../../../shared/http/errors'
import {
  readLinkedInNewsCardImageInputFromUrl,
  renderLinkedInNewsCardImage,
} from '../../content/linkedin/application/linkedin-news-card-image.service'
import {
  buildLinkedInPostPayload,
  toLinkedInProfile,
  type LinkedInAuthConfig,
  type LinkedInCreatePostInput,
  type LinkedInImageUploadInput,
  type LinkedInProfile,
  type LinkedInPublishedPost,
  type LinkedInTokenApiResponse,
  type LinkedInTokenSet,
  type LinkedInUploadedImage,
  type LinkedInUserInfoResponse,
} from '../domain/linkedin.entities'
import type { LinkedInGateway } from '../domain/linkedin.gateway'

const LINKEDIN_IMAGE_UPLOAD_MECHANISM =
  'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
const MAX_LINKEDIN_IMAGE_BYTES = 10 * 1024 * 1024
const allowedLinkedInImageTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
])

type LinkedInRegisterUploadResponse = {
  value?: {
    asset?: string
    uploadMechanism?: {
      [LINKEDIN_IMAGE_UPLOAD_MECHANISM]?: {
        uploadUrl?: string
        headers?: Record<string, string>
      }
    }
  }
}

export class LinkedInHttpGateway implements LinkedInGateway {
  constructor(private readonly config: LinkedInAuthConfig) {}

  async exchangeAuthorizationCode(code: string): Promise<LinkedInTokenSet> {
    const clientSecret = this.config.clientSecret?.trim()

    if (!clientSecret) {
      throw serviceUnavailable(
        'Missing LINKEDIN_CLIENT_SECRET environment variable',
      )
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: clientSecret,
    })

    const response = await this.safeFetch(
      'Failed to exchange LinkedIn authorization code',
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    )

    const payload = (await this.readPayload(
      response,
    )) as LinkedInTokenApiResponse | null

    if (!response.ok) {
      throw badGateway(
        this.extractErrorMessage(
          payload,
          'LinkedIn token exchange request failed',
        ),
      )
    }

    if (!payload?.access_token || typeof payload.expires_in !== 'number') {
      throw badGateway('LinkedIn token exchange returned an unexpected response')
    }

    return {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
      tokenType: payload.token_type ?? 'Bearer',
      scopes: payload.scope ? payload.scope.split(/\s+/).filter(Boolean) : [],
      idToken: payload.id_token ?? null,
      refreshToken: payload.refresh_token ?? null,
      refreshTokenExpiresIn: payload.refresh_token_expires_in ?? null,
    }
  }

  async getCurrentProfile(accessToken: string): Promise<LinkedInProfile> {
    const response = await this.safeFetch(
      'Failed to fetch LinkedIn profile',
      'https://api.linkedin.com/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )

    const payload = (await this.readPayload(
      response,
    )) as LinkedInUserInfoResponse | null

    if (!response.ok) {
      throw badGateway(
        this.extractErrorMessage(payload, 'LinkedIn profile request failed'),
      )
    }

    if (!payload?.sub) {
      throw badGateway('LinkedIn profile response did not include a member id')
    }

    return toLinkedInProfile(payload)
  }

  async uploadImage(
    accessToken: string,
    authorUrn: string,
    input: LinkedInImageUploadInput,
  ): Promise<LinkedInUploadedImage> {
    const image = await this.readUploadImage(input.imageUrl)
    const contentType = image.contentType
    const imageBytes = image.bytes

    if (imageBytes.byteLength > MAX_LINKEDIN_IMAGE_BYTES) {
      throw badGateway('LinkedIn image must be 10 MB or smaller')
    }

    const upload = await this.registerImageUpload(accessToken, authorUrn)
    const uploadHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      ...upload.headers,
    }

    const uploadResponse = await this.safeFetch(
      'Failed to upload image to LinkedIn',
      upload.uploadUrl,
      {
        method: 'PUT',
        headers: uploadHeaders,
        body: imageBytes,
      },
    )

    const uploadPayload = await this.readPayload(uploadResponse)

    if (!uploadResponse.ok) {
      throw badGateway(
        this.extractErrorMessage(uploadPayload, 'LinkedIn image upload failed'),
      )
    }

    return {
      asset: upload.asset,
      uploadUrl: upload.uploadUrl,
      contentType,
      byteLength: imageBytes.byteLength,
    }
  }

  private async readUploadImage(imageUrl: string) {
    const renderedNewsCard = await this.renderAutoFeedNewsCard(imageUrl)

    if (renderedNewsCard) {
      return renderedNewsCard
    }

    const imageResponse = await this.safeFetch(
      'Failed to fetch LinkedIn image URL',
      imageUrl,
      {
        headers: {
          Accept: 'image/jpeg,image/png,image/gif,image/*;q=0.8,*/*;q=0.5',
          'User-Agent': 'Autofeed LinkedIn publisher/1.0 (https://autofeed.io)',
        },
      },
    )

    if (!imageResponse.ok) {
      throw badGateway(
        `LinkedIn image URL could not be fetched (${imageResponse.status})`,
      )
    }

    const contentType = normalizeContentType(
      imageResponse.headers.get('content-type'),
    )

    if (!allowedLinkedInImageTypes.has(contentType)) {
      throw badGateway('LinkedIn image URL must return a JPG, PNG, or GIF image')
    }

    const imageBytes = await imageResponse.arrayBuffer()

    if (imageBytes.byteLength > MAX_LINKEDIN_IMAGE_BYTES) {
      throw badGateway('LinkedIn image must be 10 MB or smaller')
    }

    return {
      contentType,
      bytes: imageBytes,
    }
  }

  private async renderAutoFeedNewsCard(imageUrl: string) {
    let url: URL

    try {
      url = new URL(imageUrl)
    } catch {
      return null
    }

    if (url.pathname !== '/api/content/linkedin/news-card.png') {
      return null
    }

    try {
      const bytes = await renderLinkedInNewsCardImage(
        readLinkedInNewsCardImageInputFromUrl(url),
      )

      return {
        contentType: 'image/png',
        bytes: toArrayBuffer(bytes),
      }
    } catch (error) {
      throw badGateway(
        error instanceof Error && error.message
          ? `Failed to render LinkedIn news card image: ${error.message}`
          : 'Failed to render LinkedIn news card image',
      )
    }
  }

  async createPost(
    accessToken: string,
    authorUrn: string,
    input: LinkedInCreatePostInput,
  ): Promise<LinkedInPublishedPost> {
    const response = await this.safeFetch(
      'Failed to publish LinkedIn post',
      'https://api.linkedin.com/v2/ugcPosts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify(buildLinkedInPostPayload(authorUrn, input)),
      },
    )

    const payload = await this.readPayload(response)

    if (!response.ok) {
      throw badGateway(
        this.extractErrorMessage(payload, 'LinkedIn post creation failed'),
      )
    }

    let id = response.headers.get('x-restli-id')

    if (!id && payload && typeof payload === 'object' && 'id' in payload) {
      const payloadId = payload.id

      if (typeof payloadId === 'string') {
        id = payloadId
      }
    }

    return {
      id: id ?? null,
      authorUrn,
      lifecycleState: 'PUBLISHED',
      visibility: input.visibility ?? 'PUBLIC',
      commentary: input.text,
      mediaCategory: input.imageAssetUrn
        ? 'IMAGE'
        : input.articleUrl
          ? 'ARTICLE'
          : 'NONE',
      imageAssetUrn: input.imageAssetUrn ?? null,
    }
  }

  private async registerImageUpload(accessToken: string, authorUrn: string) {
    const response = await this.safeFetch(
      'Failed to register LinkedIn image upload',
      'https://api.linkedin.com/v2/assets?action=registerUpload',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({
          registerUploadRequest: {
            owner: authorUrn,
            recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
            serviceRelationships: [
              {
                relationshipType: 'OWNER',
                identifier: 'urn:li:userGeneratedContent',
              },
            ],
            supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD'],
          },
        }),
      },
    )

    const payload =
      (await this.readPayload(response)) as LinkedInRegisterUploadResponse | null

    if (!response.ok) {
      throw badGateway(
        this.extractErrorMessage(
          payload,
          'LinkedIn image upload registration failed',
        ),
      )
    }

    const asset = payload?.value?.asset
    const uploadRequest =
      payload?.value?.uploadMechanism?.[LINKEDIN_IMAGE_UPLOAD_MECHANISM]

    if (!asset || !uploadRequest?.uploadUrl) {
      throw badGateway(
        'LinkedIn image upload registration returned an unexpected response',
      )
    }

    return {
      asset,
      uploadUrl: uploadRequest.uploadUrl,
      headers: uploadRequest.headers ?? {},
    }
  }

  private async safeFetch(
    failureMessage: string,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    try {
      return await fetch(input, init)
    } catch {
      throw badGateway(failureMessage)
    }
  }

  private async readPayload(response: Response) {
    const text = await response.text()

    if (!text) {
      return null
    }

    try {
      return JSON.parse(text) as unknown
    } catch {
      return {
        message: text,
      }
    }
  }

  private extractErrorMessage(payload: unknown, fallback: string) {
    if (!payload || typeof payload !== 'object') {
      return fallback
    }

    if ('error_description' in payload) {
      const errorDescription = payload.error_description

      if (typeof errorDescription === 'string' && errorDescription.trim()) {
        return errorDescription
      }
    }

    if ('message' in payload) {
      const message = payload.message

      if (typeof message === 'string' && message.trim()) {
        return message
      }
    }

    if ('error' in payload) {
      const error = payload.error

      if (typeof error === 'string' && error.trim()) {
        return error
      }
    }

    return fallback
  }
}

function normalizeContentType(value: string | null) {
  return value?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)

  new Uint8Array(buffer).set(bytes)

  return buffer
}
