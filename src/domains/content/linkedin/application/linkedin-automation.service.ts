import {
  badRequest,
  forbidden,
  unauthorized,
} from '../../../../shared/http/errors'
import type { LinkedInProfileService } from '../../../linkedin/application/linkedin-profile.service'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInContentAutomationStatus,
  LinkedInStoredAccount,
} from '../../../linkedin/domain/linkedin.entities'
import type { LinkedInLoginRepository } from '../../../linkedin/domain/linkedin-login.repository'
import { LinkedInPublishingSessionService } from './linkedin-publishing-session.service'

export type LinkedInAutomationResult = {
  status: LinkedInContentAutomationStatus
  accountId: string
  linkedinMemberId: string
  startedAt: string | null
  stoppedAt: string | null
  updatedAt: string | null
}

export class LinkedInAutomationService {
  constructor(
    private readonly loginRepository: LinkedInLoginRepository | null,
    private readonly profileService: LinkedInProfileService,
    private readonly sessionService = new LinkedInPublishingSessionService(
      loginRepository,
    ),
  ) {}

  async updateStatus(input: {
    accessToken: string
    status: LinkedInContentAutomationStatus
    lookup?: FindLinkedInStoredAccountInput
    changedAt?: Date
  }): Promise<LinkedInAutomationResult> {
    const changedAt = input.changedAt ?? new Date()
    const account = await this.sessionService.requirePublishableAccount(
      input.lookup,
      changedAt,
    )

    await this.assertBearerTokenMatchesAccount(
      input.accessToken,
      account.linkedinMemberId,
    )

    if (!this.loginRepository) {
      throw unauthorized('LinkedIn account is not connected')
    }

    const updatedAccount =
      await this.loginRepository.updateContentAutomationStatus({
        accountId: account.id,
        status: input.status,
        changedAt: changedAt.toISOString(),
      })

    if (!updatedAccount) {
      throw unauthorized('LinkedIn account is not connected')
    }

    return toAutomationResult(updatedAccount)
  }

  private async assertBearerTokenMatchesAccount(
    accessToken: string,
    linkedinMemberId: string,
  ) {
    const profile = await this.profileService.getCurrentProfile(accessToken)

    if (profile.id !== linkedinMemberId) {
      throw forbidden(
        'Authorization token does not match the connected LinkedIn account',
      )
    }
  }
}

export function readLinkedInAutomationStatus(
  value: unknown,
): LinkedInContentAutomationStatus {
  if (value === 'start' || value === 'stop') {
    return value
  }

  throw badRequest('Automation status must be start or stop')
}

export function toAutomationResult(
  account: LinkedInStoredAccount,
): LinkedInAutomationResult {
  return {
    status: account.contentAutomationStatus,
    accountId: account.id,
    linkedinMemberId: account.linkedinMemberId,
    startedAt: account.contentAutomationStartedAt,
    stoppedAt: account.contentAutomationStoppedAt,
    updatedAt: account.contentAutomationUpdatedAt,
  }
}
