import type {
  FindLinkedInStoredAccountInput,
  LinkedInStoredAccount,
  PersistLinkedInLoginInput,
} from './linkedin.entities'

export interface LinkedInLoginRepository {
  saveLogin(input: PersistLinkedInLoginInput): Promise<LinkedInStoredAccount>
  findAccount(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInStoredAccount | null>
}
