import { badRequest } from '../../../shared/http/errors'
import {
  createSignedToken,
  verifySignedToken,
  type SignedTokenPayload,
} from '../../../shared/auth/signed-token'
import {
  readAutofeedSigningSecret,
  readLinkedInOAuthStateTtlSeconds,
} from '../../../shared/auth/autofeed-auth-config'

const LINKEDIN_OAUTH_STATE_PREFIX = 'lios_'
const LINKEDIN_OAUTH_STATE_KIND = 'linkedin-oauth'

export type LinkedInOAuthStateContext = {
  state: string
  expiresAt: string
}

type LinkedInVerifiedOAuthStateContext = {
  clientState: string | null
  returnUri: string | null
}

type LinkedInOAuthStatePayload = SignedTokenPayload & {
  kind: typeof LINKEDIN_OAUTH_STATE_KIND
  nonce: string
  clientState: string | null
  returnUri: string | null
}

export class LinkedInOAuthStateService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  static fromEnv(env: Env) {
    return new LinkedInOAuthStateService(
      readAutofeedSigningSecret(env),
      readLinkedInOAuthStateTtlSeconds(env),
    )
  }

  async create(input?: {
    clientState?: string
    returnUri?: string
  }): Promise<LinkedInOAuthStateContext> {
    const nonce = crypto.randomUUID()
    const signed = await createSignedToken({
      prefix: LINKEDIN_OAUTH_STATE_PREFIX,
      secret: this.secret,
      ttlSeconds: this.ttlSeconds,
      payload: {
        kind: LINKEDIN_OAUTH_STATE_KIND,
        nonce,
        clientState: input?.clientState ?? null,
        returnUri: input?.returnUri ?? null,
      },
    })

    return {
      state: signed.token,
      expiresAt: new Date(signed.expiresAt * 1000).toISOString(),
    }
  }

  async verify(state: string): Promise<LinkedInVerifiedOAuthStateContext> {
    const payload = await verifySignedToken<LinkedInOAuthStatePayload>({
      token: state,
      prefix: LINKEDIN_OAUTH_STATE_PREFIX,
      secret: this.secret,
    })

    if (payload.kind !== LINKEDIN_OAUTH_STATE_KIND || !payload.nonce) {
      throw badRequest('Invalid LinkedIn OAuth state')
    }

    return {
      clientState: payload.clientState,
      returnUri: payload.returnUri,
    }
  }
}
