import {
  forbidden,
  serviceUnavailable,
  unauthorized,
} from '../../../../shared/http/errors'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInPublishAccount,
} from '../../../linkedin/domain/linkedin.entities'
import type { LinkedInLoginRepository } from '../../../linkedin/domain/linkedin-login.repository'

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000
const LINKEDIN_POSTING_SCOPE = 'w_member_social'

export class LinkedInPublishingSessionService {
  constructor(private readonly loginRepository: LinkedInLoginRepository | null) {}

  async requirePublishableAccount(
    input?: FindLinkedInStoredAccountInput,
    checkedAt = new Date(),
  ) {
    if (!this.loginRepository) {
      throw serviceUnavailable('Missing DATABASE_URL environment variable')
    }

    const account = await this.loginRepository.findPublishableAccount(input)

    if (!account) {
      throw unauthorized('LinkedIn account is not connected')
    }

    assertPublishableLinkedInAccount(account, checkedAt)

    return account
  }
}

export function assertPublishableLinkedInAccount(
  account: LinkedInPublishAccount,
  checkedAt = new Date(),
) {
  if (!account.linkedinMemberId.trim()) {
    throw unauthorized('LinkedIn account profile is incomplete; reconnect LinkedIn')
  }

  if (!account.authorUrn.trim()) {
    throw unauthorized('LinkedIn author is missing; reconnect LinkedIn')
  }

  if (!account.accessToken.trim()) {
    throw unauthorized('LinkedIn access token is missing; reconnect LinkedIn')
  }

  if (account.tokenType.trim().toLowerCase() !== 'bearer') {
    throw unauthorized('LinkedIn token type is invalid; reconnect LinkedIn')
  }

  if (!account.scopes.includes(LINKEDIN_POSTING_SCOPE)) {
    throw forbidden(
      'LinkedIn account is missing posting permission; reconnect LinkedIn with w_member_social scope',
    )
  }

  const checkedAtMs = checkedAt.getTime()
  const expiresAtMs = Date.parse(account.accessTokenExpiresAt)

  if (
    Number.isNaN(checkedAtMs) ||
    Number.isNaN(expiresAtMs) ||
    expiresAtMs <= checkedAtMs + TOKEN_EXPIRY_BUFFER_MS
  ) {
    throw unauthorized('LinkedIn session expired; reconnect LinkedIn')
  }
}

export function canPublishWithLinkedInAccount(input: {
  connected: boolean
  account: {
    scopes: string[]
    accessTokenExpired: boolean
  } | null
}) {
  return Boolean(
    input.connected &&
      input.account &&
      !input.account.accessTokenExpired &&
      input.account.scopes.includes(LINKEDIN_POSTING_SCOPE),
  )
}
