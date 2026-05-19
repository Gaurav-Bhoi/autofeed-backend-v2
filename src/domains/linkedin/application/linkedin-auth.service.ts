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
import { LinkedInOAuthStateService } from './linkedin-oauth-state.service'

export class LinkedInAuthService {
  constructor(
    private readonly gateway: LinkedInGateway,
    private readonly config: LinkedInAuthConfig,
    private readonly loginRepository?: LinkedInLoginRepository | null,
    private readonly oauthStateService?: LinkedInOAuthStateService,
  ) {}

  async createLogin(options?: {
    state?: string
    scopes?: string[]
    returnUri?: string
  }): Promise<LinkedInLoginResult> {
    const scopes = normalizeLinkedInScopes(options?.scopes)
    const oauthStateInput: {
      clientState?: string
      returnUri?: string
    } = {}
    const clientState = options?.state?.trim()

    if (clientState) {
      oauthStateInput.clientState = clientState
    }

    if (options?.returnUri) {
      oauthStateInput.returnUri = options.returnUri
    }

    const oauthState = await this.getOAuthStateService().create(oauthStateInput)

    return {
      authorizationUrl: buildLinkedInAuthorizationUrl({
        clientId: this.config.clientId,
        redirectUri: this.config.redirectUri,
        scopes,
        state: oauthState.state,
      }),
      state: oauthState.state,
      stateExpiresAt: oauthState.expiresAt,
      scopes,
      redirectUri: this.config.redirectUri,
      returnUri: options?.returnUri ?? null,
      clientState: clientState || null,
    }
  }

  async handleCallback(
    code: string,
    context?: {
      state?: string | null
      requestId?: string | null
    },
  ): Promise<LinkedInCallbackResult> {
    const oauthState = await this.getOAuthStateService().verify(
      context?.state ?? '',
    )
    const tokens = await this.gateway.exchangeAuthorizationCode(code)
    const profile = await this.gateway.getCurrentProfile(tokens.accessToken)

    if (!this.loginRepository) {
      throw serviceUnavailable('Missing DATABASE_URL environment variable')
    }

    const storedAccount = await this.loginRepository.saveLogin({
      profile,
      tokens,
      state: oauthState.clientState,
      requestId: context?.requestId ?? null,
      loggedInAt: new Date().toISOString(),
    })

    return {
      tokens,
      profile,
      storedAccount,
      clientState: oauthState.clientState,
      returnUri: oauthState.returnUri,
    }
  }

  private getOAuthStateService() {
    if (!this.oauthStateService) {
      throw serviceUnavailable('Missing LinkedIn OAuth state service')
    }

    return this.oauthStateService
  }
}
