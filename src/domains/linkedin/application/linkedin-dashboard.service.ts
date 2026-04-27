import { serviceUnavailable } from '../../../shared/http/errors'
import type { LinkedInLoginRepository } from '../domain/linkedin-login.repository'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInDashboardResult,
} from '../domain/linkedin.entities'

export class LinkedInDashboardService {
  constructor(
    private readonly loginRepository?: LinkedInLoginRepository | null,
  ) {}

  async getDashboard(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInDashboardResult> {
    if (!this.loginRepository) {
      throw serviceUnavailable('Missing DATABASE_URL environment variable')
    }

    const account = await this.loginRepository.findAccount(input)

    if (!account) {
      return {
        connected: false,
        account: null,
      }
    }

    const now = Date.now()
    const accessTokenExpiresAtMs = Date.parse(account.accessTokenExpiresAt)
    const refreshTokenExpiresAtMs =
      account.refreshTokenExpiresAt === null
        ? null
        : Date.parse(account.refreshTokenExpiresAt)

    return {
      connected: true,
      account: {
        id: account.id,
        linkedinMemberId: account.linkedinMemberId,
        authorUrn: account.authorUrn,
        email: account.email,
        name: account.name,
        givenName: account.givenName,
        familyName: account.familyName,
        picture: account.picture,
        locale: account.locale,
        scopes: account.scopes,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        accessTokenExpired:
          Number.isNaN(accessTokenExpiresAtMs) || accessTokenExpiresAtMs <= now,
        refreshTokenAvailable: account.refreshTokenExpiresAt !== null,
        refreshTokenExpiresAt: account.refreshTokenExpiresAt,
        refreshTokenExpired:
          refreshTokenExpiresAtMs === null
            ? null
            : Number.isNaN(refreshTokenExpiresAtMs) || refreshTokenExpiresAtMs <= now,
        contentAutomationStatus: account.contentAutomationStatus,
        contentAutomationStartedAt: account.contentAutomationStartedAt,
        contentAutomationStoppedAt: account.contentAutomationStoppedAt,
        contentAutomationUpdatedAt: account.contentAutomationUpdatedAt,
        lastLoginAt: account.lastLoginAt,
        loginCount: account.loginCount,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
    }
  }
}
