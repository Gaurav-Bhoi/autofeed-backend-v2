import type {
  FindLinkedInStoredAccountInput,
  LinkedInContentAutomationStatus,
  LinkedInPublishAccount,
  LinkedInStoredAccount,
  PersistLinkedInLoginInput,
} from './linkedin.entities'

export interface LinkedInLoginRepository {
  saveLogin(input: PersistLinkedInLoginInput): Promise<LinkedInStoredAccount>
  findAccount(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInStoredAccount | null>
  findPublishableAccount(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInPublishAccount | null>
  updateContentAutomationStatus(input: {
    accountId: string
    status: LinkedInContentAutomationStatus
    changedAt: string
  }): Promise<LinkedInStoredAccount | null>
}
