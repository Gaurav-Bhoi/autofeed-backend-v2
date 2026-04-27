import { badRequest, serviceUnavailable } from '../../../../shared/http/errors'
import type {
  LinkedInPostInput,
  LinkedInPublishAccount,
  LinkedInPublishedPost,
  LinkedInVisibility,
} from '../../../linkedin/domain/linkedin.entities'
import type {
  LinkedInContentAiJobRecord,
  LinkedInContentHistoryRepository,
} from '../domain/linkedin-content-history.repository'
import type { LinkedInContentTone } from '../domain/linkedin-content.entity'
import {
  LinkedInContentEngineService,
  type LinkedInContentEngineInput,
  type LinkedInContentSelection,
} from './linkedin-content-engine.service'
import type {
  LinkedInContentPublisher,
  LinkedInContentPublishInput,
} from './publish-linkedin-content.service'
import {
  composeLinkedInText,
  getNextRunPodImageInputMode,
  readRunPodImageInputMode,
  RunPodLinkedInContentService,
  type RunPodImageInputMode,
  type RunPodJobResult,
} from './runpod-linkedin-content.service'

type RunPodAttemptResult =
  | {
      ok: true
      result: RunPodJobResult
    }
  | {
      ok: false
      error: string
    }

type LinkedInContentPublishOverrides = Partial<{
  topic: string
  audience: string
  objective: string
  keyPoints: string[]
  tone: LinkedInContentTone
  callToAction: string
  articleUrl: string
  articleTitle: string
  articleDescription: string
  imageTitle: string
  imageDescription: string
  imageAltText: string
  visibility: LinkedInVisibility
}>

export type PublishSingleLinkedInAiContentInput = {
  accessToken: string
  account: LinkedInPublishAccount
  imageUrl?: string
  section?: string
  sourceUrl?: string
  forceNew?: boolean
  contentOverrides?: LinkedInContentPublishOverrides
  contentEngine?: LinkedInContentEngineInput
  visibility?: LinkedInVisibility
}

export type PublishSingleLinkedInAiContentResult =
  | {
      posted: true
      reason: null
      contentKey: string
      contentSection: string
      contentItemId: string | null
      sourceUrl: string | null
      imageUrl: string
      runpodJobId: string | null
      runpodStatus: string | null
      aiContent: {
        caption: string
        postContent: string
        hashtags: string[]
      }
      post: LinkedInPublishedPost
    }
  | {
      posted: false
      reason: string
      contentKey: string
      contentSection: string
      contentItemId: string | null
      sourceUrl: string | null
      imageUrl: string | null
      runpodJobId: string | null
      runpodStatus: string | null
      retryable: boolean
    }

export class PublishSingleLinkedInAiContentService {
  constructor(
    private readonly publisher: LinkedInContentPublisher,
    private readonly contentHistoryRepository: LinkedInContentHistoryRepository | null,
    private readonly runPodService: RunPodLinkedInContentService,
    private readonly contentEngine = new LinkedInContentEngineService(),
  ) {}

  async execute(
    input: PublishSingleLinkedInAiContentInput,
    requestedAt = new Date(),
  ): Promise<PublishSingleLinkedInAiContentResult> {
    if (!this.contentHistoryRepository) {
      throw serviceUnavailable('LinkedIn content history storage is unavailable')
    }

    if (!input.forceNew && !input.imageUrl) {
      const pendingJob =
        await this.contentHistoryRepository.findPendingAiJob({
          accountId: input.account.id,
          linkedinMemberId: input.account.linkedinMemberId,
        })

      if (pendingJob) {
        return this.processJob(pendingJob, input, requestedAt)
      }
    }

    const selection = input.imageUrl
      ? createManualSelection(input)
      : await this.selectGeneratedImage(input)
    const imageUrl = selection.input.imageUrl?.trim()

    if (!imageUrl) {
      throw serviceUnavailable(
        'Selected LinkedIn single-post content must include imageUrl',
      )
    }

    await this.contentHistoryRepository.reserveAiJob({
      contentKey: selection.contentKey,
      section: selection.section,
      itemId: selection.itemId,
      sourceUrl: selection.sourceUrl,
      imageUrl,
      contentInput: selection.input,
      accountId: input.account.id,
      linkedinMemberId: input.account.linkedinMemberId,
      publishedAt: requestedAt.toISOString(),
    })

    return this.processJob(
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
        accountId: input.account.id,
        linkedinMemberId: input.account.linkedinMemberId,
        publishedAt: requestedAt.toISOString(),
      },
      input,
      requestedAt,
    )
  }

  private async selectGeneratedImage(
    input: PublishSingleLinkedInAiContentInput,
  ) {
    const engineInput: LinkedInContentEngineInput = {
      ...input.contentEngine,
      historyRepository: this.contentHistoryRepository,
    }

    if (input.section) {
      engineInput.sections = [input.section]
    }

    const selection = await this.contentEngine.select(engineInput)

    return {
      ...selection,
      input: applyContentOverrides(selection.input, input.contentOverrides),
    }
  }

  private async processJob(
    job: LinkedInContentAiJobRecord,
    input: PublishSingleLinkedInAiContentInput,
    requestedAt: Date,
  ): Promise<PublishSingleLinkedInAiContentResult> {
    const contentInput = readStoredContentInput(job.contentInput)
    const imageUrl = job.imageUrl ?? contentInput.imageUrl

    if (!imageUrl) {
      await this.contentHistoryRepository?.markAiFailed({
        contentKey: job.contentKey,
        aiError: 'Stored LinkedIn AI job does not include an image URL',
      })

      return createUnpostedResult(job, 'runpod-job-failed', {
        imageUrl: null,
        retryable: false,
      })
    }

    let currentJob: LinkedInContentAiJobRecord = {
      ...job,
      imageUrl,
      contentInput,
    }
    let imageInputMode = readRunPodImageInputMode(currentJob.runpodInputMode)
    let lastError: string | null = null

    while (imageInputMode) {
      const attempt = await this.submitOrWaitForRunPod(
        currentJob,
        contentInput,
        imageUrl,
        imageInputMode,
      )

      if (!attempt.ok) {
        const nextMode = getNextRunPodImageInputMode(imageInputMode)

        if (!nextMode) {
          await this.contentHistoryRepository?.markAiFailed({
            contentKey: currentJob.contentKey,
            aiError: attempt.error,
          })

          return createUnpostedResult(currentJob, 'runpod-job-failed', {
            imageUrl,
            runpodStatus: attempt.error,
            retryable: false,
          })
        }

        lastError = attempt.error
        await this.contentHistoryRepository?.markRunPodRetry({
          contentKey: currentJob.contentKey,
          runpodInputMode: nextMode,
          aiError: `${lastError}; retrying input mode`,
        })
        currentJob = {
          ...currentJob,
          runpodInputMode: nextMode,
          runpodAttempt: currentJob.runpodAttempt + 1,
          runpodJobId: null,
          runpodStatus: null,
        }
        imageInputMode = nextMode
        continue
      }

      const completed = attempt.result

      if (completed.status.toUpperCase() !== 'COMPLETED') {
        if (!isFailedRunPodStatus(completed.status)) {
          await this.contentHistoryRepository?.markRunPodSubmitted({
            contentKey: currentJob.contentKey,
            runpodInputMode: imageInputMode,
            runpodJobId: completed.id,
            runpodStatus: completed.status,
          })

          return createUnpostedResult(currentJob, 'runpod-job-pending', {
            imageUrl,
            runpodJobId: completed.id,
            runpodStatus: completed.status,
            retryable: true,
          })
        }

        const nextMode = getNextRunPodImageInputMode(imageInputMode)

        if (!nextMode) {
          await this.contentHistoryRepository?.markAiFailed({
            contentKey: currentJob.contentKey,
            runpodStatus: completed.status,
            aiError: completed.error ?? 'RunPod job failed',
          })

          return createUnpostedResult(currentJob, 'runpod-job-failed', {
            imageUrl,
            runpodJobId: completed.id,
            runpodStatus: completed.status,
            retryable: false,
          })
        }

        await this.contentHistoryRepository?.markRunPodRetry({
          contentKey: currentJob.contentKey,
          runpodInputMode: nextMode,
          aiError: completed.error ?? 'RunPod job failed; retrying input mode',
        })
        currentJob = {
          ...currentJob,
          runpodInputMode: nextMode,
          runpodAttempt: currentJob.runpodAttempt + 1,
          runpodJobId: null,
          runpodStatus: null,
        }
        imageInputMode = nextMode
        continue
      }

      await this.contentHistoryRepository?.markAiCompleted({
        contentKey: currentJob.contentKey,
        runpodStatus: completed.status,
        aiOutput: completed.output,
      })

      const aiPost = this.runPodService.parsePostContent(completed.output)
      const text = composeLinkedInText(aiPost)
      const postInput: LinkedInPostInput = {
        text,
        imageUrl,
        imageTitle: aiPost.caption,
        imageDescription: aiPost.caption,
        imageAltText: contentInput.imageAltText ?? aiPost.caption,
        visibility:
          contentInput.visibility ?? input.visibility ?? ('PUBLIC' as const),
      }
      const post = await this.publisher.publish(input.accessToken, postInput, {
        expectedLinkedInMemberId: input.account.linkedinMemberId,
      })

      await this.contentHistoryRepository?.markPosted({
        contentKey: currentJob.contentKey,
        linkedinPostId: post.id,
      })

      return {
        posted: true,
        reason: null,
        contentKey: currentJob.contentKey,
        contentSection: currentJob.section,
        contentItemId: currentJob.itemId,
        sourceUrl: currentJob.sourceUrl,
        imageUrl,
        runpodJobId: completed.id,
        runpodStatus: completed.status,
        aiContent: aiPost,
        post,
      }
    }

    await this.contentHistoryRepository?.markAiFailed({
      contentKey: currentJob.contentKey,
      aiError: 'RunPod input mode selection failed',
    })

    return createUnpostedResult(currentJob, 'runpod-job-failed', {
      imageUrl,
      retryable: false,
    })
  }

  private async submitOrWaitForRunPod(
    job: LinkedInContentAiJobRecord,
    contentInput: LinkedInContentPublishInput,
    imageUrl: string,
    imageInputMode: RunPodImageInputMode,
  ): Promise<RunPodAttemptResult> {
    try {
      if (job.runpodJobId) {
        if (
          job.runpodStatus?.toUpperCase() === 'COMPLETED' &&
          job.aiOutput !== undefined
        ) {
          return {
            ok: true,
            result: {
              id: job.runpodJobId,
              status: job.runpodStatus,
              output: job.aiOutput,
              error: null,
            },
          }
        }

        return {
          ok: true,
          result: await this.runPodService.waitForResult(job.runpodJobId),
        }
      }

      const submitted = await this.runPodService.submit({
        imageUrl,
        section: job.section,
        sourceUrl: job.sourceUrl,
        contentInput,
        imageInputMode,
      })

      await this.contentHistoryRepository?.markRunPodSubmitted({
        contentKey: job.contentKey,
        runpodInputMode: imageInputMode,
        runpodJobId: submitted.id,
        runpodStatus: submitted.status,
      })

      if (
        submitted.status.toUpperCase() === 'COMPLETED' &&
        submitted.output !== undefined
      ) {
        return {
          ok: true,
          result: submitted,
        }
      }

      return {
        ok: true,
        result: await this.runPodService.waitForResult(submitted.id),
      }
    } catch (error) {
      return {
        ok: false,
        error: readErrorMessage(error),
      }
    }
  }
}

function createManualSelection(
  input: PublishSingleLinkedInAiContentInput,
): LinkedInContentSelection {
  const imageUrl = cleanHttpUrl(input.imageUrl, 'imageUrl')
  const sourceUrl =
    cleanOptionalHttpUrl(input.sourceUrl, 'sourceUrl') ??
    cleanOptionalHttpUrl(input.contentOverrides?.articleUrl, 'articleUrl') ??
    imageUrl
  const topic =
    input.contentOverrides?.topic?.trim() ||
    input.contentOverrides?.imageTitle?.trim() ||
    'Technology image for LinkedIn'
  const section = normalizeSectionName(input.section ?? 'manual-image')
  const contentInput = createManualContentInput({
    ...input.contentOverrides,
    topic,
    imageUrl,
  })
  const itemId = `${hashString(imageUrl)}:${slugify(topic)}`

  return {
    contentKey: `manual:${section}:${itemId}`,
    section,
    itemId,
    sourceUrl,
    input: contentInput,
  }
}

function createManualContentInput(
  input: LinkedInContentPublishOverrides & {
    topic: string
    imageUrl: string
  },
): LinkedInContentPublishInput {
  const contentInput: LinkedInContentPublishInput = {
    topic: input.topic,
    audience: input.audience ?? 'developers and technology teams',
    objective:
      input.objective ?? 'turn the image into a useful LinkedIn discussion',
    keyPoints: input.keyPoints ?? [
      'Read the image first, then connect it to a practical technology lesson',
      'Keep the post useful for builders and technical leaders',
      'Make the takeaway clear without over-explaining the visual',
    ],
    tone: input.tone ?? 'professional',
    callToAction: input.callToAction ?? 'What is your take on this?',
    imageUrl: input.imageUrl,
    imageTitle: input.imageTitle ?? input.topic,
    imageDescription:
      input.imageDescription ?? 'User-provided image for LinkedIn.',
    imageAltText:
      input.imageAltText ?? `Image for LinkedIn post about ${input.topic}.`,
  }

  if (input.visibility !== undefined) {
    contentInput.visibility = input.visibility
  }

  return contentInput
}

function applyContentOverrides(
  input: LinkedInContentPublishInput,
  overrides?: LinkedInContentPublishOverrides,
): LinkedInContentPublishInput {
  if (!overrides) {
    return input
  }

  const next: LinkedInContentPublishInput = {
    ...input,
  }

  assignOptional(next, 'topic', overrides.topic)
  assignOptional(next, 'audience', overrides.audience)
  assignOptional(next, 'objective', overrides.objective)
  assignOptional(next, 'keyPoints', overrides.keyPoints)
  assignOptional(next, 'tone', overrides.tone)
  assignOptional(next, 'callToAction', overrides.callToAction)
  assignOptional(next, 'articleUrl', overrides.articleUrl)
  assignOptional(next, 'articleTitle', overrides.articleTitle)
  assignOptional(next, 'articleDescription', overrides.articleDescription)
  assignOptional(next, 'imageTitle', overrides.imageTitle)
  assignOptional(next, 'imageDescription', overrides.imageDescription)
  assignOptional(next, 'imageAltText', overrides.imageAltText)
  assignOptional(next, 'visibility', overrides.visibility)

  return next
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
  const imageUrl = readStoredString(record, 'imageUrl')
  const imageTitle = readStoredString(record, 'imageTitle')
  const imageDescription = readStoredString(record, 'imageDescription')
  const imageAltText = readStoredString(record, 'imageAltText')
  const visibility = readStoredString(record, 'visibility')

  assignOptional(input, 'audience', audience)
  assignOptional(input, 'objective', objective)

  if (keyPoints.length > 0) {
    input.keyPoints = keyPoints
  }

  assignOptional(input, 'tone', tone as LinkedInContentTone | null)
  assignOptional(input, 'callToAction', callToAction)
  assignOptional(input, 'imageUrl', imageUrl)
  assignOptional(input, 'imageTitle', imageTitle)
  assignOptional(input, 'imageDescription', imageDescription)
  assignOptional(input, 'imageAltText', imageAltText)
  assignOptional(input, 'visibility', visibility as LinkedInVisibility | null)

  return input
}

function createUnpostedResult(
  job: LinkedInContentAiJobRecord,
  reason: string,
  overrides: {
    imageUrl?: string | null
    runpodJobId?: string | null
    runpodStatus?: string | null
    retryable: boolean
  },
): PublishSingleLinkedInAiContentResult {
  return {
    posted: false,
    reason,
    contentKey: job.contentKey,
    contentSection: job.section,
    contentItemId: job.itemId,
    sourceUrl: job.sourceUrl,
    imageUrl: overrides.imageUrl ?? job.imageUrl,
    runpodJobId: overrides.runpodJobId ?? job.runpodJobId,
    runpodStatus: overrides.runpodStatus ?? job.runpodStatus,
    retryable: overrides.retryable,
  }
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

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'RunPod job submission failed'
}

function cleanHttpUrl(value: string | undefined, fieldName: string) {
  if (!value?.trim()) {
    throw badRequest(`${fieldName} is required`)
  }

  const cleaned = value.trim()

  try {
    const url = new URL(cleaned)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }

    return url.toString()
  } catch {
    throw badRequest(`${fieldName} must be a valid HTTP or HTTPS URL`)
  }
}

function cleanOptionalHttpUrl(value: string | undefined, fieldName: string) {
  if (!value?.trim()) {
    return undefined
  }

  return cleanHttpUrl(value, fieldName)
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

function assignOptional<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined,
) {
  if (value !== undefined && value !== null) {
    target[key] = value
  }
}

function normalizeSectionName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 80) || 'image'
  )
}

function hashString(value: string) {
  let hash = 5381

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }

  return (hash >>> 0).toString(36)
}
