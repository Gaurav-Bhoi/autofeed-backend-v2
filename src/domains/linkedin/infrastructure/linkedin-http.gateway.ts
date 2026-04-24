import { badGateway, serviceUnavailable } from '../../../shared/http/errors'
import {
  buildLinkedInPostPayload,
  toLinkedInProfile,
  type LinkedInAuthConfig,
  type LinkedInPostInput,
  type LinkedInProfile,
  type LinkedInPublishedPost,
  type LinkedInTokenApiResponse,
  type LinkedInTokenSet,
  type LinkedInUserInfoResponse,
} from '../domain/linkedin.entities'
import type { LinkedInGateway } from '../domain/linkedin.gateway'

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

  async createPost(
    accessToken: string,
    authorUrn: string,
    input: LinkedInPostInput,
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
