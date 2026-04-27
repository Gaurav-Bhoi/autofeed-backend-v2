export type LinkedInContentUsageInput = {
  contentKey: string
  section: string
  itemId?: string | null
  sourceUrl?: string | null
  imageUrl?: string | null
  contentInput?: unknown
  aiStatus?: LinkedInContentAiStatus
  runpodInputMode?: string
  runpodAttempt?: number
  runpodJobId?: string | null
  runpodStatus?: string | null
  aiOutput?: unknown
  aiError?: string | null
  linkedinPostId?: string | null
  accountId?: string | null
  linkedinMemberId?: string | null
  publishedAt: string
}

export type LinkedInContentAiStatus =
  | 'reserved'
  | 'submitted'
  | 'in_queue'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'posted'

export type LinkedInContentAiJobRecord = {
  contentKey: string
  section: string
  itemId: string | null
  sourceUrl: string | null
  imageUrl: string | null
  contentInput: unknown
  aiStatus: LinkedInContentAiStatus
  runpodInputMode: string
  runpodAttempt: number
  runpodJobId: string | null
  runpodStatus: string | null
  aiOutput: unknown
  aiError: string | null
  linkedinPostId: string | null
  accountId: string | null
  linkedinMemberId: string | null
  publishedAt: string
}

export type LinkedInContentReservationInput = {
  contentKey: string
  section: string
  itemId?: string | null
  sourceUrl?: string | null
  imageUrl?: string | null
  contentInput: unknown
  accountId: string
  linkedinMemberId: string
  publishedAt: string
}

export interface LinkedInContentHistoryRepository {
  findUsedKeys(contentKeys: string[]): Promise<Set<string>>
  findUsedItemIds(itemIds: string[]): Promise<Set<string>>
  findPendingAiJob(input: {
    accountId?: string
    linkedinMemberId?: string
  }): Promise<LinkedInContentAiJobRecord | null>
  reserveAiJob(input: LinkedInContentReservationInput): Promise<void>
  markRunPodSubmitted(input: {
    contentKey: string
    runpodInputMode: string
    runpodJobId: string
    runpodStatus: string
  }): Promise<void>
  markRunPodRetry(input: {
    contentKey: string
    runpodInputMode: string
    aiError: string
  }): Promise<void>
  markAiCompleted(input: {
    contentKey: string
    runpodStatus: string
    aiOutput: unknown
  }): Promise<void>
  markAiFailed(input: {
    contentKey: string
    runpodStatus?: string | null
    aiError: string
  }): Promise<void>
  markPosted(input: {
    contentKey: string
    linkedinPostId?: string | null
  }): Promise<void>
  markUsed(input: LinkedInContentUsageInput): Promise<void>
}
