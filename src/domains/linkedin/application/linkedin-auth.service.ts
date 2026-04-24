import { serviceUnavailable } from '../../../shared/http/errors'
import type { LinkedInLoginRepository } from '../domain/linkedin-login.repository'
import type { LinkedInGateway } from '../domain/linkedin.gateway'
import {
  buildLinkedInAuthorizationUrl,
  type LinkedInCallbackResult,
  type LinkedInAuthConfig,
  type LinkedInLoginResult,
  normalizeLinkedInScopes,
} from '../domain/linkedin.entities'

export class LinkedInAuthService {
  constructor(
    private readonly gateway: LinkedInGateway,
    private readonly config: LinkedInAuthConfig,
    private readonly loginRepository?: LinkedInLoginRepository | null,
  ) {}

  createLogin(options?: {
    state?: string
    scopes?: string[]
  }): LinkedInLoginResult {
    const state = options?.state?.trim() || crypto.randomUUID()
    const scopes = normalizeLinkedInScopes(options?.scopes)

    return {
      authorizationUrl: buildLinkedInAuthorizationUrl({
        clientId: this.config.clientId,
        redirectUri: this.config.redirectUri,
        scopes,
        state,
      }),
      state,
      scopes,
      redirectUri: this.config.redirectUri,
    }
  }

  async handleCallback(
    code: string,
    context?: {
      state?: string | null
      requestId?: string | null
    },
  ): Promise<LinkedInCallbackResult> {
    const tokens = await this.gateway.exchangeAuthorizationCode(code)
    const profile = await this.gateway.getCurrentProfile(tokens.accessToken)

    if (!this.loginRepository) {
      throw serviceUnavailable('Missing DATABASE_URL environment variable')
    }

    const storedAccount = await this.loginRepository.saveLogin({
      profile,
      tokens,
      state: context?.state ?? null,
      requestId: context?.requestId ?? null,
      loggedInAt: new Date().toISOString(),
    })

    return {
      tokens,
      profile,
      storedAccount,
    }
  }
}
