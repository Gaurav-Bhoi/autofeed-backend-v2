import { loadLinkedInServices } from '../../linkedin/infrastructure/load-linkedin-services'
import {
  readLinkedInContentPool,
  readLinkedInContentSections,
  readLinkedInMemeSubreddits,
  readLinkedInRedditSubreddits,
  type LinkedInContentEngineInput,
} from '../linkedin/application/linkedin-content-engine.service'
import {
  PublishScheduledLinkedInContentService,
  readLinkedInAutoPostSchedule,
  type ScheduledLinkedInContentConfig,
} from '../linkedin/application/publish-scheduled-linkedin-content.service'
import {
  readRunPodLinkedInContentConfig,
  RunPodLinkedInContentService,
} from '../linkedin/application/runpod-linkedin-content.service'

type LinkedInAutoPostEnv = Env & {
  LINKEDIN_REDIRECT_URI?: string
  CONTENT_LINKEDIN_AUTO_POST_SCHEDULE?: string
  CONTENT_LINKEDIN_AUTO_POST_ACCOUNT_ID?: string
  CONTENT_LINKEDIN_AUTO_POST_MEMBER_ID?: string
  CONTENT_LINKEDIN_AUTO_POST_SECTIONS?: string
  CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL?: string
  CONTENT_LINKEDIN_MEME_SUBREDDITS?: string
  CONTENT_LINKEDIN_REDDIT_SUBREDDITS?: string
  CONTENT_LINKEDIN_REDDIT_USER_AGENT?: string
  CONTENT_LINKEDIN_AUTO_POST_VISIBILITY?: string
}

export async function handleScheduledContent(
  controller: ScheduledController,
  env: Env,
) {
  const startedAt = performance.now()
  const scheduledAt = new Date(controller.scheduledTime)

  try {
    const { contentHistoryRepository, loginRepository, postService } =
      await loadLinkedInServices(env)
    const config = readScheduledLinkedInContentConfig(env)
    const runPodService =
      config.schedule === 'off'
        ? null
        : new RunPodLinkedInContentService(
            readRunPodLinkedInContentConfig(env),
          )
    const service = new PublishScheduledLinkedInContentService(
      loginRepository,
      postService,
      contentHistoryRepository,
      runPodService,
    )
    const result = await service.execute(config, scheduledAt)

    console.log(
      JSON.stringify({
        message: 'content.linkedin.scheduled.complete',
        cron: controller.cron,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        ...result,
      }),
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'content.linkedin.scheduled.error',
        cron: controller.cron,
        scheduledAt: scheduledAt.toISOString(),
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        error:
          error instanceof Error && error.message
            ? error.message
            : 'Scheduled LinkedIn content publishing failed',
      }),
    )

    throw error
  }
}

function readScheduledLinkedInContentConfig(
  env: Env,
): ScheduledLinkedInContentConfig {
  const autoPostEnv = env as LinkedInAutoPostEnv
  const engineInput: LinkedInContentEngineInput = {}
  const pool = readLinkedInContentPool(
    autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL,
  )
  const sections = readLinkedInContentSections(
    autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_SECTIONS,
  )
  const redditSubreddits = readLinkedInRedditSubreddits(
    autoPostEnv.CONTENT_LINKEDIN_REDDIT_SUBREDDITS,
  )
  const memeSubreddits = readLinkedInMemeSubreddits(
    autoPostEnv.CONTENT_LINKEDIN_MEME_SUBREDDITS,
  )
  const redditUserAgent =
    autoPostEnv.CONTENT_LINKEDIN_REDDIT_USER_AGENT?.trim()

  if (pool) {
    engineInput.pool = pool
  }

  if (sections && sections.length > 0) {
    engineInput.sections = sections
  }

  if (redditSubreddits.length > 0) {
    engineInput.redditSubreddits = redditSubreddits
  }

  if (memeSubreddits.length > 0) {
    engineInput.memeSubreddits = memeSubreddits
  }

  if (redditUserAgent) {
    engineInput.redditUserAgent = redditUserAgent
  }

  const publicBaseUrl = readPublicBaseUrlFromEnv(autoPostEnv)

  if (publicBaseUrl) {
    engineInput.publicBaseUrl = publicBaseUrl
  }

  const config: ScheduledLinkedInContentConfig = {
    schedule: readLinkedInAutoPostSchedule(
      autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_SCHEDULE,
    ),
    contentEngine: engineInput,
  }

  assignOptional(
    config,
    'accountId',
    autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_ACCOUNT_ID,
  )
  assignOptional(
    config,
    'linkedinMemberId',
    autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_MEMBER_ID,
  )

  if (!config.visibility) {
    assignOptional(
      config,
      'visibility',
      autoPostEnv.CONTENT_LINKEDIN_AUTO_POST_VISIBILITY,
    )
  }

  return config
}

function readPublicBaseUrlFromEnv(env: LinkedInAutoPostEnv) {
  const redirectUri = env.LINKEDIN_REDIRECT_URI?.trim()

  if (!redirectUri) {
    return undefined
  }

  try {
    return new URL(redirectUri).origin
  } catch {
    return undefined
  }
}

function assignOptional<
  T extends ScheduledLinkedInContentConfig,
  K extends keyof ScheduledLinkedInContentConfig,
>(target: T, key: K, value?: string | null) {
  const cleaned = value?.trim()

  if (cleaned) {
    target[key] = cleaned as T[K]
  }
}
