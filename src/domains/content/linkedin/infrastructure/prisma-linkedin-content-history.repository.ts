import type { Prisma } from '../../../../generated/prisma/client'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type {
  LinkedInContentAiJobRecord,
  LinkedInContentAiStatus,
  LinkedInContentHistoryRepository,
  LinkedInContentReservationInput,
  LinkedInRunPodSubmissionClaimResult,
  LinkedInContentUsageInput,
} from '../domain/linkedin-content-history.repository'

type PrismaLinkedInContentHistory = Awaited<
  ReturnType<PrismaClient['linkedInContentHistory']['findFirst']>
>

export class PrismaLinkedInContentHistoryRepository
  implements LinkedInContentHistoryRepository
{
  constructor(private readonly prisma: PrismaClient) {}

  async findUsedKeys(contentKeys: string[]): Promise<Set<string>> {
    if (contentKeys.length === 0) {
      return new Set()
    }

    const records = await this.prisma.linkedInContentHistory.findMany({
      where: {
        contentKey: {
          in: [...new Set(contentKeys)],
        },
      },
      select: {
        contentKey: true,
      },
    })

    return new Set(records.map((record) => record.contentKey))
  }

  async findUsedItemIds(itemIds: string[]): Promise<Set<string>> {
    if (itemIds.length === 0) {
      return new Set()
    }

    const records = await this.prisma.linkedInContentHistory.findMany({
      where: {
        itemId: {
          in: [...new Set(itemIds)],
        },
      },
      select: {
        itemId: true,
      },
    })

    return new Set(
      records
        .map((record) => record.itemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    )
  }

  async findPendingAiJob(input: {
    accountId?: string
    linkedinMemberId?: string
  }): Promise<LinkedInContentAiJobRecord | null> {
    const record = await this.prisma.linkedInContentHistory.findFirst({
      where: {
        linkedinPostId: null,
        aiStatus: {
          in: [
            'reserved',
            'submitting',
            'submitted',
            'in_queue',
            'in_progress',
            'completed',
          ],
        },
        ...(input.accountId
          ? {
              accountId: input.accountId,
            }
          : {}),
        ...(input.linkedinMemberId
          ? {
              linkedinMemberId: input.linkedinMemberId,
            }
          : {}),
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    return toAiJobRecord(record)
  }

  async findAiJobByContentKey(
    contentKey: string,
  ): Promise<LinkedInContentAiJobRecord | null> {
    const record = await this.prisma.linkedInContentHistory.findUnique({
      where: {
        contentKey,
      },
    })

    return toAiJobRecord(record)
  }

  async reserveAiJob(input: LinkedInContentReservationInput): Promise<void> {
    const publishedAt = new Date(input.publishedAt)

    await this.prisma.linkedInContentHistory.upsert({
      where: {
        contentKey: input.contentKey,
      },
      update: {
        section: input.section,
        itemId: input.itemId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        imageUrl: input.imageUrl ?? null,
        contentInputJson: toJsonValue(input.contentInput),
        accountId: input.accountId,
        linkedinMemberId: input.linkedinMemberId,
        publishedAt,
      },
      create: {
        id: crypto.randomUUID(),
        contentKey: input.contentKey,
        section: input.section,
        itemId: input.itemId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        imageUrl: input.imageUrl ?? null,
        contentInputJson: toJsonValue(input.contentInput),
        aiStatus: 'reserved',
        runpodInputMode: 'image-url',
        runpodAttempt: 0,
        accountId: input.accountId,
        linkedinMemberId: input.linkedinMemberId,
        publishedAt,
      },
    })
  }

  async claimRunPodSubmission(input: {
    contentKey: string
    runpodInputMode: string
    staleBefore: string
    dailyLimitWindowStart: string
    dailyLimitWindowEnd: string
    dailyLimit: number
  }): Promise<LinkedInRunPodSubmissionClaimResult> {
    const staleBefore = new Date(input.staleBefore)
    const dailyLimitWindowStart = new Date(input.dailyLimitWindowStart)
    const dailyLimitWindowEnd = new Date(input.dailyLimitWindowEnd)
    const claimed = await this.prisma.$executeRaw`
      UPDATE linkedin_content_history AS target
      SET
        ai_status = 'submitting',
        runpod_input_mode = ${input.runpodInputMode},
        runpod_status = 'SUBMITTING',
        runpod_attempt = target.runpod_attempt + 1,
        ai_error = NULL,
        updated_at = NOW()
      WHERE target.content_key = ${input.contentKey}
        AND target.runpod_job_id IS NULL
        AND target.runpod_attempt = 0
        AND (
          target.ai_status = 'reserved'
          OR (
            target.ai_status = 'submitting'
            AND target.updated_at <= ${staleBefore}
          )
        )
        AND (
          SELECT COUNT(*)
          FROM linkedin_content_history AS existing
          WHERE existing.content_key <> target.content_key
            AND existing.published_at >= ${dailyLimitWindowStart}
            AND existing.published_at < ${dailyLimitWindowEnd}
            AND (
              (
                target.account_id IS NOT NULL
                AND existing.account_id = target.account_id
              )
              OR (
                target.linkedin_member_id IS NOT NULL
                AND existing.linkedin_member_id = target.linkedin_member_id
              )
            )
            AND (
              existing.runpod_job_id IS NOT NULL
              OR existing.runpod_attempt > 0
              OR existing.ai_status IN (
                'submitting',
                'submitted',
                'in_queue',
                'in_progress',
                'completed',
                'failed',
                'posted'
              )
            )
        ) < ${input.dailyLimit}
    `

    if (claimed > 0) {
      return 'claimed'
    }

    return (await this.hasReachedRunPodSubmissionLimit(input))
      ? 'daily-limit-reached'
      : 'pending'
  }

  private async hasReachedRunPodSubmissionLimit(input: {
    contentKey: string
    dailyLimitWindowStart: string
    dailyLimitWindowEnd: string
    dailyLimit: number
  }) {
    const dailyLimitWindowStart = new Date(input.dailyLimitWindowStart)
    const dailyLimitWindowEnd = new Date(input.dailyLimitWindowEnd)
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT (
        CASE
          WHEN target.runpod_attempt > 0 THEN 1
          ELSE 0
        END
        +
        (
          SELECT COUNT(*)::int
          FROM linkedin_content_history AS existing
          WHERE existing.content_key <> target.content_key
            AND existing.published_at >= ${dailyLimitWindowStart}
            AND existing.published_at < ${dailyLimitWindowEnd}
            AND (
              (
                target.account_id IS NOT NULL
                AND existing.account_id = target.account_id
              )
              OR (
                target.linkedin_member_id IS NOT NULL
                AND existing.linkedin_member_id = target.linkedin_member_id
              )
            )
            AND (
              existing.runpod_job_id IS NOT NULL
              OR existing.runpod_attempt > 0
              OR existing.ai_status IN (
                'submitting',
                'submitted',
                'in_queue',
                'in_progress',
                'completed',
                'failed',
                'posted'
              )
            )
        )
      )::int AS count
      FROM linkedin_content_history AS target
      WHERE target.content_key = ${input.contentKey}
      LIMIT 1
    `
    const count = rows[0]?.count ?? 0

    return count >= input.dailyLimit
  }

  async markRunPodSubmitted(input: {
    contentKey: string
    runpodInputMode: string
    runpodJobId: string
    runpodStatus: string
  }): Promise<void> {
    await this.prisma.linkedInContentHistory.update({
      where: {
        contentKey: input.contentKey,
      },
      data: {
        aiStatus: normalizeAiStatus(input.runpodStatus, 'submitted'),
        runpodInputMode: input.runpodInputMode,
        runpodJobId: input.runpodJobId,
        runpodStatus: input.runpodStatus,
        aiError: null,
      },
    })
  }

  async markRunPodRetry(input: {
    contentKey: string
    runpodInputMode: string
    aiError: string
  }): Promise<void> {
    await this.prisma.linkedInContentHistory.update({
      where: {
        contentKey: input.contentKey,
      },
      data: {
        aiStatus: 'reserved',
        runpodInputMode: input.runpodInputMode,
        runpodAttempt: {
          increment: 1,
        },
        runpodJobId: null,
        runpodStatus: null,
        aiError: input.aiError,
      },
    })
  }

  async markAiCompleted(input: {
    contentKey: string
    runpodStatus: string
    aiOutput: unknown
  }): Promise<void> {
    await this.prisma.linkedInContentHistory.update({
      where: {
        contentKey: input.contentKey,
      },
      data: {
        aiStatus: 'completed',
        runpodStatus: input.runpodStatus,
        aiOutputJson: toJsonValue(input.aiOutput),
        aiError: null,
      },
    })
  }

  async markAiFailed(input: {
    contentKey: string
    runpodStatus?: string | null
    aiError: string
  }): Promise<void> {
    await this.prisma.linkedInContentHistory.update({
      where: {
        contentKey: input.contentKey,
      },
      data: {
        aiStatus: 'failed',
        runpodStatus: input.runpodStatus ?? null,
        aiError: input.aiError,
      },
    })
  }

  async markPosted(input: {
    contentKey: string
    linkedinPostId?: string | null
  }): Promise<void> {
    await this.prisma.linkedInContentHistory.update({
      where: {
        contentKey: input.contentKey,
      },
      data: {
        aiStatus: 'posted',
        linkedinPostId: input.linkedinPostId ?? null,
      },
    })
  }

  async markUsed(input: LinkedInContentUsageInput): Promise<void> {
    const publishedAt = new Date(input.publishedAt)

    await this.prisma.linkedInContentHistory.upsert({
      where: {
        contentKey: input.contentKey,
      },
      update: {
        section: input.section,
        itemId: input.itemId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        imageUrl: input.imageUrl ?? null,
        ...(input.contentInput === undefined
          ? {}
          : {
              contentInputJson: toJsonValue(input.contentInput),
            }),
        ...(input.aiStatus === undefined
          ? {}
          : {
              aiStatus: input.aiStatus,
            }),
        ...(input.runpodInputMode === undefined
          ? {}
          : {
              runpodInputMode: input.runpodInputMode,
            }),
        ...(input.runpodAttempt === undefined
          ? {}
          : {
              runpodAttempt: input.runpodAttempt,
            }),
        ...(input.runpodJobId === undefined
          ? {}
          : {
              runpodJobId: input.runpodJobId,
            }),
        ...(input.runpodStatus === undefined
          ? {}
          : {
              runpodStatus: input.runpodStatus,
            }),
        ...(input.aiOutput === undefined
          ? {}
          : {
              aiOutputJson: toJsonValue(input.aiOutput),
            }),
        aiError: input.aiError ?? null,
        linkedinPostId: input.linkedinPostId ?? null,
        accountId: input.accountId ?? null,
        linkedinMemberId: input.linkedinMemberId ?? null,
        publishedAt,
      },
      create: {
        id: crypto.randomUUID(),
        contentKey: input.contentKey,
        section: input.section,
        itemId: input.itemId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        imageUrl: input.imageUrl ?? null,
        contentInputJson: toJsonValue(input.contentInput ?? {}),
        aiStatus: input.aiStatus ?? 'posted',
        runpodInputMode: input.runpodInputMode ?? 'image-url',
        runpodAttempt: input.runpodAttempt ?? 0,
        runpodJobId: input.runpodJobId ?? null,
        runpodStatus: input.runpodStatus ?? null,
        ...(input.aiOutput === undefined
          ? {}
          : {
              aiOutputJson: toJsonValue(input.aiOutput),
            }),
        aiError: input.aiError ?? null,
        linkedinPostId: input.linkedinPostId ?? null,
        accountId: input.accountId ?? null,
        linkedinMemberId: input.linkedinMemberId ?? null,
        publishedAt,
      },
    })
  }
}

function toAiJobRecord(
  record: PrismaLinkedInContentHistory,
): LinkedInContentAiJobRecord | null {
  if (!record) {
    return null
  }

  return {
    contentKey: record.contentKey,
    section: record.section,
    itemId: record.itemId,
    sourceUrl: record.sourceUrl,
    imageUrl: record.imageUrl,
    contentInput: record.contentInputJson,
    aiStatus: normalizeAiStatus(record.aiStatus, 'reserved'),
    runpodInputMode: record.runpodInputMode,
    runpodAttempt: record.runpodAttempt,
    runpodJobId: record.runpodJobId,
    runpodStatus: record.runpodStatus,
    aiOutput: record.aiOutputJson,
    aiError: record.aiError,
    linkedinPostId: record.linkedinPostId,
    accountId: record.accountId,
    linkedinMemberId: record.linkedinMemberId,
    publishedAt: record.publishedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function normalizeAiStatus(
  status: string | null,
  fallback: LinkedInContentAiStatus,
): LinkedInContentAiStatus {
  switch (status?.toLowerCase()) {
    case 'reserved':
      return 'reserved'
    case 'submitting':
      return 'submitting'
    case 'submitted':
      return 'submitted'
    case 'in_queue':
    case 'queued':
      return 'in_queue'
    case 'in_progress':
    case 'processing':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
    case 'timed_out':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    case 'posted':
      return 'posted'
    default:
      return fallback
  }
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) {
    return {}
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
