import {
  forbidden,
  unauthorized,
} from '../../../shared/http/errors'
import {
  createSignedToken,
  verifySignedToken,
  type SignedTokenPayload,
} from '../../../shared/auth/signed-token'
import {
  readAutofeedSessionTtlSeconds,
  readAutofeedSigningSecret,
} from '../../../shared/auth/autofeed-auth-config'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInStoredAccount,
} from '../domain/linkedin.entities'

const LINKEDIN_ACCOUNT_SESSION_PREFIX = 'afs_'
const LINKEDIN_ACCOUNT_SESSION_KIND = 'linkedin-account'

export const LINKEDIN_ACCOUNT_SESSION_SCOPES = [
  'linkedin:automation',
  'linkedin:publish',
] as const

export type LinkedInAccountSessionScope =
  (typeof LINKEDIN_ACCOUNT_SESSION_SCOPES)[number]

export type LinkedInAccountSession = {
  tokenType: 'Bearer'
  accessToken: string
  expiresAt: string
  scopes: LinkedInAccountSessionScope[]
  accountId: string
  linkedinMemberId: string
}

type LinkedInAccountSessionPayload = SignedTokenPayload & {
  kind: typeof LINKEDIN_ACCOUNT_SESSION_KIND
  accountId: string
  linkedinMemberId: string
  scopes: LinkedInAccountSessionScope[]
}

export class LinkedInAccountSessionService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  static fromEnv(env: Env) {
    return new LinkedInAccountSessionService(
      readAutofeedSigningSecret(env),
      readAutofeedSessionTtlSeconds(env),
    )
  }

  async createSession(
    account: Pick<LinkedInStoredAccount, 'id' | 'linkedinMemberId'>,
  ): Promise<LinkedInAccountSession> {
    const result = await createSignedToken({
      prefix: LINKEDIN_ACCOUNT_SESSION_PREFIX,
      secret: this.secret,
      ttlSeconds: this.ttlSeconds,
      payload: {
        kind: LINKEDIN_ACCOUNT_SESSION_KIND,
        accountId: account.id,
        linkedinMemberId: account.linkedinMemberId,
        scopes: [...LINKEDIN_ACCOUNT_SESSION_SCOPES],
      },
    })

    return {
      tokenType: 'Bearer',
      accessToken: result.token,
      expiresAt: new Date(result.expiresAt * 1000).toISOString(),
      scopes: [...LINKEDIN_ACCOUNT_SESSION_SCOPES],
      accountId: account.id,
      linkedinMemberId: account.linkedinMemberId,
    }
  }

  async requireSession(input: {
    authorizationHeader?: string | null
    token?: string
    lookup?: FindLinkedInStoredAccountInput
    requiredScope?: LinkedInAccountSessionScope
  }) {
    const token =
      input.token?.trim() ?? readBearerToken(input.authorizationHeader)
    const session =
      await verifySignedToken<LinkedInAccountSessionPayload>({
        token,
        prefix: LINKEDIN_ACCOUNT_SESSION_PREFIX,
        secret: this.secret,
      })

    if (session.kind !== LINKEDIN_ACCOUNT_SESSION_KIND) {
      throw unauthorized('Invalid session token')
    }

    if (
      input.requiredScope &&
      !session.scopes.includes(input.requiredScope)
    ) {
      throw forbidden('Session token is missing the required permission')
    }

    if (
      input.lookup?.accountId &&
      input.lookup.accountId !== session.accountId
    ) {
      throw forbidden('Session token does not match the requested account')
    }

    if (
      input.lookup?.linkedinMemberId &&
      input.lookup.linkedinMemberId !== session.linkedinMemberId
    ) {
      throw forbidden('Session token does not match the requested account')
    }

    return session
  }
}

export function isAutofeedLinkedInSessionToken(token: string) {
  return token.trim().startsWith(LINKEDIN_ACCOUNT_SESSION_PREFIX)
}

function readBearerToken(authorizationHeader?: string | null) {
  if (!authorizationHeader) {
    throw unauthorized('Missing Authorization header')
  }

  const [scheme, ...rawTokenParts] = authorizationHeader.trim().split(/\s+/)

  if (scheme !== 'Bearer' || rawTokenParts.length === 0) {
    throw unauthorized('Authorization header must use the Bearer scheme')
  }

  const token = rawTokenParts.join(' ').trim()

  if (!token) {
    throw unauthorized('Authorization header is missing the bearer token')
  }

  return token
}
