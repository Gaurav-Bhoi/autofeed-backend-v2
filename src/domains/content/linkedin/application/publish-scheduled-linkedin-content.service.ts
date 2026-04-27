import { HTTPException } from 'hono/http-exception'

import { serviceUnavailable } from '../../../../shared/http/errors'
import type { LinkedInPostService } from '../../../linkedin/application/linkedin-post.service'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInPostInput,
  LinkedInPublishAccount,
  LinkedInVisibility,
} from '../../../linkedin/domain/linkedin.entities'
import type { LinkedInLoginRepository } from '../../../linkedin/domain/linkedin-login.repository'
import { LinkedInPublishingSessionService } from './linkedin-publishing-session.service'
import type {
  LinkedInContentAiJobRecord,
  LinkedInContentHistoryRepository,
} from '../domain/linkedin-content-history.repository'
import {
  LinkedInContentEngineService,
  type LinkedInContentEngineInput,
} from './linkedin-content-engine.service'
import {
  composeLinkedInText,
  getNextRunPodImageInputMode,
  readRunPodImageInputMode,
  RunPodLinkedInContentService,
} from './runpod-linkedin-content.service'
import type { LinkedInContentPublishInput } from './publish-linkedin-content.service'
import type { LinkedInContentTone } from '../domain/linkedin-content.entity'

const IST_DAILY_TEN_AM_UTC_HOUR = 4
const IST_DAILY_TEN_AM_UTC_MINUTE = 30
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const EIGHTEEN_HOURS_MS = 18 * 60 * 60 * 1000
const everyEighteenHoursAnchor = Date.UTC(2026, 0, 1, 4, 30, 0)

export type LinkedInAutoPostSchedule =
  | 'daily-10am'
  | 'every-18-hours'
  | 'off'

export type ScheduledLinkedInContentConfig = {
  schedule: LinkedInAutoPostSchedule
  accountId?: string
  linkedinMemberId?: string
  contentEngine?: LinkedInContentEngineInput
  visibility?: LinkedInVisibility
}

export type ScheduledLinkedInPostResult =
  | {
      posted: false
      schedule: LinkedInAutoPostSchedule
      scheduledAt: string
      reason: string
      contentSection: string | null
      contentItemId: string | null
      runpodJobId: string | null
      runpodStatus: string | null
    }
  | {
      posted: true
      schedule: LinkedInAutoPostSchedule
      scheduledAt: string
      accountId: string
      linkedinMemberId: string
      postId: string | null
      characterCount: number
      contentSection: string | null
      contentItemId: string | null
      runpodJobId: string | null
      runpodStatus: string | null
    }

export class PublishScheduledLinkedInContentService {
  constructor(
    private readonly loginRepository: LinkedInLoginRepository | null,
    private readonly postService: LinkedInPostService,
    private readonly contentHistoryRepository: LinkedInContentHistoryRepository | null,
    private readonly runPodService: RunPodLinkedInContentService | null,
    private readonly contentEngine = new LinkedInContentEngineService(),
  ) {}

  async execute(
    config: ScheduledLinkedInContentConfig,
    scheduledAt: Date,
  ): Promise<ScheduledLinkedInPostResult> {
    if (config.schedule === 'off') {
      return {
        posted: false,
        schedule: config.schedule,
        scheduledAt: scheduledAt.toISOString(),
        reason: 'schedule-off',
        contentSection: null,
        contentItemId: null,
        runpodJobId: null,
        runpodStatus: null,
      }
    }

    const sessionService = new LinkedInPublishingSessionService(
      this.loginRepository,
    )
    const account = await this.findScheduledAccount(
      sessionService,
      config,
      scheduledAt,
    )

    if (!account) {
      return {
        posted: false,
        schedule: config.schedule,
        scheduledAt: scheduledAt.toISOString(),
        reason: 'linkedin-account-not-publishable',
        contentSection: null,
        contentItemId: null,
        runpodJobId: null,
        runpodStatus: null,
      }
    }

    if (account.contentAutomationStatus !== 'start') {
      return {
        posted: false,
        schedule: config.schedule,
        scheduledAt: scheduledAt.toISOString(),
        reason: 'automation-stopped',
        contentSection: null,
        contentItemId: null,
        runpodJobId: null,
        runpodStatus: null,
      }
    }

    const pendingJob = await this.contentHistoryRepository?.findPendingAiJob({
      accountId: account.id,
      linkedinMemberId: account.linkedinMemberId,
    })

    if (pendingJob) {
      return this.processAiJob(pendingJob, account, config, scheduledAt)
    }

    if (!shouldRun(config.schedule, scheduledAt)) {
      return {
        posted: false,
        schedule: config.schedule,
        scheduledAt: scheduledAt.toISOString(),
        reason: 'outside-configured-posting-window',
        contentSection: null,
        contentItemId: null,
        runpodJobId: null,
        runpodStatus: null,
      }
    }

    if (!this.contentHistoryRepository) {
      throw serviceUnavailable('LinkedIn content history storage is unavailable')
    }

    const selection = await this.contentEngine.select({
      ...config.contentEngine,
      historyRepository: this.contentHistoryRepository,
    })
    const imageUrl = selection.input.imageUrl?.trim()

    if (!imageUrl) {
      throw serviceUnavailable(
        'Selected LinkedIn content must include imageUrl for AI post creation',
      )
    }

    await this.contentHistoryRepository.reserveAiJob({
      contentKey: selection.contentKey,
      section: selection.section,
      itemId: selection.itemId,
      sourceUrl: selection.sourceUrl,
      imageUrl,
      contentInput: selection.input,
      accountId: account.id,
      linkedinMemberId: account.linkedinMemberId,
      publishedAt: scheduledAt.toISOString(),
    })

    return this.processAiJob(
      {
        contentKey: selection.contentKey,
        section: selection.section,
        itemId: selection.itemId,
        sourceUrl: selection.sourceUrl,
        imageUrl,
        contentInput: selection.input,
        aiStatus: 'reserved',
        runpodInputMode: 'image-url',
        runpodAttempt: 0,
        runpodJobId: null,
        runpodStatus: null,
        aiOutput: null,
        aiError: null,
        linkedinPostId: null,
        accountId: account.id,
        publishedAt: scheduledAt.toISOString(),
        linkedinMemberId: account.linkedinMemberId,
      },
      account,
      config,
      scheduledAt,
    )
  }

  private async processAiJob(
    job: LinkedInContentAiJobRecord,
    account: LinkedInPublishAccount,
    config: ScheduledLinkedInContentConfig,
    scheduledAt: Date,
  ): Promise<ScheduledLinkedInPostResult> {
    const contentInput = readStoredContentInput(job.contentInput)
    const imageUrl = job.imageUrl ?? contentInput.imageUrl

    if (!this.runPodService) {
      throw serviceUnavailable('RunPod LinkedIn content service is unavailable')
    }

    if (!imageUrl) {
      await this.contentHistoryRepository?.markAiFailed({
        contentKey: job.contentKey,
        aiError: 'Stored LinkedIn AI job does not include an image URL',
      })

      return this.createAiPendingResult(
        config,
        scheduledAt,
        job,
        'runpod-job-failed',
      )
    }

    let runpodJobId = job.runpodJobId
    let runpodStatus = job.runpodStatus
    let output = job.aiOutput
    const imageInputMode = readRunPodImageInputMode(job.runpodInputMode)

    if (!runpodJobId) {
      const submitted = await this.runPodService.submit({
        imageUrl,
        section: job.section,
        sourceUrl: job.sourceUrl,
        contentInput,
        imageInputMode,
      })

      runpodJobId = submitted.id
      runpodStatus = submitted.status
      output = submitted.output

      await this.contentHistoryRepository?.markRunPodSubmitted({
        contentKey: job.contentKey,
        runpodInputMode: imageInputMode,
        runpodJobId,
        runpodStatus,
      })
    }

    const completed =
      runpodStatus?.toUpperCase() === 'COMPLETED' && output !== undefined
        ? {
            id: runpodJobId,
            status: runpodStatus,
            output,
            error: null,
          }
        : await this.runPodService.waitForResult(runpodJobId)

    runpodStatus = completed.status
    output = completed.output

    if (completed.status.toUpperCase() !== 'COMPLETED') {
      if (isFailedRunPodStatus(completed.status)) {
        const nextMode = getNextRunPodImageInputMode(imageInputMode)

        if (nextMode) {
          await this.contentHistoryRepository?.markRunPodRetry({
            contentKey: job.contentKey,
            runpodInputMode: nextMode,
            aiError: completed.error ?? 'RunPod job failed; retrying input mode',
          })

          return this.createAiPendingResult(
            config,
            scheduledAt,
            job,
            'runpod-job-retrying',
            null,
            `retrying:${nextMode}`,
          )
        }

        await this.contentHistoryRepository?.markAiFailed({
          contentKey: job.contentKey,
          runpodStatus: completed.status,
          aiError: completed.error ?? 'RunPod job failed',
        })

        return this.createAiPendingResult(
          config,
          scheduledAt,
          job,
          'runpod-job-failed',
          runpodJobId,
          completed.status,
        )
      }

      await this.contentHistoryRepository?.markRunPodSubmitted({
        contentKey: job.contentKey,
        runpodInputMode: imageInputMode,
        runpodJobId,
        runpodStatus: completed.status,
      })

      return this.createAiPendingResult(
        config,
        scheduledAt,
        job,
        'runpod-job-pending',
        runpodJobId,
        completed.status,
      )
    }

    await this.contentHistoryRepository?.markAiCompleted({
      contentKey: job.contentKey,
      runpodStatus,
      aiOutput: output,
    })

    let aiPost

    try {
      aiPost = this.runPodService.parsePostContent(output)
    } catch (error) {
      await this.contentHistoryRepository?.markAiFailed({
        contentKey: job.contentKey,
        runpodStatus,
        aiError:
          error instanceof Error && error.message
            ? error.message
            : 'Failed to parse AI-generated LinkedIn content',
      })

      throw error
    }

    const text = composeLinkedInText(aiPost)
    const postInput: LinkedInPostInput = {
      text,
      imageUrl,
      imageTitle: aiPost.caption,
      imageDescription: aiPost.caption,
      imageAltText: contentInput.imageAltText ?? aiPost.caption,
      visibility: contentInput.visibility ?? config.visibility ?? 'PUBLIC',
    }
    const post = await this.postService.publish(
      account.accessToken,
      postInput,
      {
        expectedLinkedInMemberId: account.linkedinMemberId,
      },
    )

    await this.contentHistoryRepository?.markPosted({
      contentKey: job.contentKey,
      linkedinPostId: post.id,
    })

    return {
      posted: true,
      schedule: config.schedule,
      scheduledAt: scheduledAt.toISOString(),
      accountId: account.id,
      linkedinMemberId: account.linkedinMemberId,
      postId: post.id,
      characterCount: text.length,
      contentSection: job.section,
      contentItemId: job.itemId,
      runpodJobId,
      runpodStatus,
    }
  }

  private createAiPendingResult(
    config: ScheduledLinkedInContentConfig,
    scheduledAt: Date,
    job: LinkedInContentAiJobRecord,
    reason: string,
    runpodJobId = job.runpodJobId,
    runpodStatus = job.runpodStatus,
  ): ScheduledLinkedInPostResult {
    return {
      posted: false,
      schedule: config.schedule,
      scheduledAt: scheduledAt.toISOString(),
      reason,
      contentSection: job.section,
      contentItemId: job.itemId,
      runpodJobId,
      runpodStatus,
    }
  }

  private async findScheduledAccount(
    sessionService: LinkedInPublishingSessionService,
    config: ScheduledLinkedInContentConfig,
    scheduledAt: Date,
  ) {
    try {
      return await sessionService.requirePublishableAccount(
        buildAccountLookup(config),
        scheduledAt,
      )
    } catch (error) {
      if (
        error instanceof HTTPException &&
        (error.status === 401 || error.status === 403)
      ) {
        console.warn(
          JSON.stringify({
            message: 'content.linkedin.scheduled.validation_failed',
            schedule: config.schedule,
            scheduledAt: scheduledAt.toISOString(),
            error: error.message,
          }),
        )

        return null
      }

      throw error
    }
  }
}

export function readLinkedInAutoPostSchedule(
  value?: string | null,
): LinkedInAutoPostSchedule {
  const schedule = value?.trim().toLowerCase()

  if (!schedule) {
    return 'daily-10am'
  }

  if (
    schedule === 'daily-10am' ||
    schedule === 'every-18-hours' ||
    schedule === 'off'
  ) {
    return schedule
  }

  throw serviceUnavailable(
    'CONTENT_LINKEDIN_AUTO_POST_SCHEDULE must be daily-10am, every-18-hours, or off',
  )
}

export function readLinkedInAutoPostTone(
  value?: string | null,
): LinkedInContentTone {
  const tone = value?.trim().toLowerCase()

  if (!tone) {
    return 'professional'
  }

  if (
    tone === 'professional' ||
    tone === 'conversational' ||
    tone === 'educational' ||
    tone === 'bold'
  ) {
    return tone
  }

  throw serviceUnavailable(
    'CONTENT_LINKEDIN_AUTO_POST_TONE must be professional, conversational, educational, or bold',
  )
}

export function shouldRun(
  schedule: LinkedInAutoPostSchedule,
  scheduledAt: Date,
) {
  if (schedule === 'off') {
    return false
  }

  const time = scheduledAt.getTime()

  if (Number.isNaN(time)) {
    return false
  }

  const minute = scheduledAt.getUTCMinutes()

  if (minute !== IST_DAILY_TEN_AM_UTC_MINUTE) {
    return false
  }

  if (schedule === 'daily-10am') {
    return scheduledAt.getUTCHours() === IST_DAILY_TEN_AM_UTC_HOUR
  }

  if ((time - everyEighteenHoursAnchor) % SIX_HOURS_MS !== 0) {
    return false
  }

  return (time - everyEighteenHoursAnchor) % EIGHTEEN_HOURS_MS === 0
}

function buildAccountLookup(config: ScheduledLinkedInContentConfig) {
  const lookup: FindLinkedInStoredAccountInput = {}

  if (config.accountId) {
    lookup.accountId = config.accountId
  }

  if (config.linkedinMemberId) {
    lookup.linkedinMemberId = config.linkedinMemberId
  }

  return Object.keys(lookup).length === 0 ? undefined : lookup
}

function readStoredContentInput(value: unknown): LinkedInContentPublishInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceUnavailable('Stored LinkedIn content input is invalid')
  }

  const record = value as Record<string, unknown>
  const topic = readStoredString(record, 'topic')

  if (!topic) {
    throw serviceUnavailable('Stored LinkedIn content input is missing topic')
  }

  const input: LinkedInContentPublishInput = {
    topic,
  }
  const audience = readStoredString(record, 'audience')
  const objective = readStoredString(record, 'objective')
  const keyPoints = readStoredStringArray(record, 'keyPoints')
  const tone = readStoredString(record, 'tone')
  const callToAction = readStoredString(record, 'callToAction')
  const articleUrl = readStoredString(record, 'articleUrl')
  const articleTitle = readStoredString(record, 'articleTitle')
  const articleDescription = readStoredString(record, 'articleDescription')
  const imageUrl = readStoredString(record, 'imageUrl')
  const imageTitle = readStoredString(record, 'imageTitle')
  const imageDescription = readStoredString(record, 'imageDescription')
  const imageAltText = readStoredString(record, 'imageAltText')
  const visibility = readStoredString(record, 'visibility')

  if (audience) {
    input.audience = audience
  }

  if (objective) {
    input.objective = objective
  }

  if (keyPoints.length > 0) {
    input.keyPoints = keyPoints
  }

  if (tone) {
    input.tone = tone as LinkedInContentTone
  }

  if (callToAction) {
    input.callToAction = callToAction
  }

  if (articleUrl) {
    input.articleUrl = articleUrl
  }

  if (articleTitle) {
    input.articleTitle = articleTitle
  }

  if (articleDescription) {
    input.articleDescription = articleDescription
  }

  if (imageUrl) {
    input.imageUrl = imageUrl
  }

  if (imageTitle) {
    input.imageTitle = imageTitle
  }

  if (imageDescription) {
    input.imageDescription = imageDescription
  }

  if (imageAltText) {
    input.imageAltText = imageAltText
  }

  if (visibility) {
    input.visibility = visibility as LinkedInVisibility
  }

  return input
}

function readStoredString(record: Record<string, unknown>, key: string) {
  const value = record[key]

  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStoredStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key]

  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}

function isFailedRunPodStatus(status: string) {
  return [
    'FAILED',
    'ERROR',
    'CANCELLED',
    'CANCELED',
    'TIMED_OUT',
  ].includes(status.toUpperCase())
}
