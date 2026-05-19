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
  shouldRun,
  type ScheduledLinkedInContentConfig,
  type ScheduledLinkedInPostResult,
} from '../linkedin/application/publish-scheduled-linkedin-content.service'
import {
  isTerminalRunPodStatus,
  readRunPodLinkedInContentConfig,
  RunPodLinkedInContentService,
} from '../linkedin/application/runpod-linkedin-content.service'
import {
  createContentSchedulerStateStore,
  type ContentSchedulerStateStore,
  type ScheduledRunPodPendingJob,
} from './content-scheduler-state.service'

const LINKEDIN_MODULE = 'linkedin'
const MAX_PENDING_RUNPOD_STATUS_CHECKS_PER_MODULE = 25

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

type ScheduledContentModuleResult = {
  module: string
  status: 'skipped' | 'handled' | 'pending' | 'error'
  reason?: string
  pendingJobs?: number
  runpodJobId?: string | null
  runpodStatus?: string | null
  result?: unknown
  error?: string
}

export async function handleScheduledContent(
  controller: ScheduledController,
  env: Env,
) {
  const startedAt = performance.now()
  const scheduledAt = new Date(controller.scheduledTime)
  const stateStore = createContentSchedulerStateStore(env)
  const moduleResults: ScheduledContentModuleResult[] = []

  moduleResults.push(
    await runScheduledContentModule(LINKEDIN_MODULE, async () =>
      handleScheduledLinkedInContent({
        env,
        stateStore,
        scheduledAt,
      }),
    ),
  )

  if (!isIdleSchedulerTick(moduleResults)) {
    console.log(
      JSON.stringify({
        message: 'content.scheduled.complete',
        cron: controller.cron,
        scheduledAt: scheduledAt.toISOString(),
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        schedulerStateEnabled: stateStore.enabled,
        modules: moduleResults,
      }),
    )
  }
}

async function runScheduledContentModule(
  moduleName: string,
  handler: () => Promise<Omit<ScheduledContentModuleResult, 'module'>>,
): Promise<ScheduledContentModuleResult> {
  try {
    return {
      module: moduleName,
      ...(await handler()),
    }
  } catch (error) {
    const message = readErrorMessage(error)

    console.error(
      JSON.stringify({
        message: 'content.scheduled.module_error',
        module: moduleName,
        error: message,
      }),
    )

    return {
      module: moduleName,
      status: 'error',
      error: message,
    }
  }
}

async function handleScheduledLinkedInContent(input: {
  env: Env
  stateStore: ContentSchedulerStateStore
  scheduledAt: Date
}): Promise<Omit<ScheduledContentModuleResult, 'module'>> {
  const config = readScheduledLinkedInContentConfig(input.env)

  if (config.schedule === 'off') {
    return {
      status: 'skipped',
      reason: 'schedule-off',
    }
  }

  const shouldCreatePost = shouldHandleLinkedInSchedulerTick(
    config,
    input.scheduledAt,
  )
  const pendingJobs = await input.stateStore.listPendingRunPodJobs(
    LINKEDIN_MODULE,
  )

  if (!shouldCreatePost && pendingJobs.length === 0) {
    return {
      status: 'skipped',
      reason: 'no-due-work-or-pending-runpod-job',
      pendingJobs: 0,
    }
  }

  if (!shouldCreatePost) {
    return pollPendingLinkedInRunPodJobs({
      ...input,
      config,
      pendingJobs,
    })
  }

  const result = await executeScheduledLinkedInContent(
    input.env,
    config,
    input.scheduledAt,
  )
  await syncLinkedInPendingRunPodState(input.stateStore, result)

  return {
    status: result.posted ? 'handled' : 'pending',
    reason: result.posted ? 'posted' : result.reason,
    pendingJobs: pendingJobs.length,
    runpodJobId: result.runpodJobId,
    runpodStatus: result.runpodStatus,
    result,
  }
}

async function pollPendingLinkedInRunPodJobs(input: {
  env: Env
  stateStore: ContentSchedulerStateStore
  scheduledAt: Date
  config: ScheduledLinkedInContentConfig
  pendingJobs: ScheduledRunPodPendingJob[]
}): Promise<Omit<ScheduledContentModuleResult, 'module'>> {
  const runPodService = new RunPodLinkedInContentService(
    readRunPodLinkedInContentConfig(input.env),
  )
  let checked = 0

  for (const pendingJob of input.pendingJobs.slice(
    0,
    MAX_PENDING_RUNPOD_STATUS_CHECKS_PER_MODULE,
  )) {
    checked += 1
    const status = await runPodService.getStatus(pendingJob.runpodJobId)

    if (!isTerminalRunPodStatus(status.status)) {
      await input.stateStore.putPendingRunPodJob({
        module: LINKEDIN_MODULE,
        accountId: pendingJob.accountId,
        externalAccountId: pendingJob.externalAccountId,
        contentKey: pendingJob.contentKey,
        runpodJobId: pendingJob.runpodJobId,
        runpodStatus: status.status,
      })

      continue
    }

    const result = await executeScheduledLinkedInContent(
      input.env,
      input.config,
      input.scheduledAt,
    )
    await syncLinkedInPendingRunPodState(
      input.stateStore,
      result,
      pendingJob,
    )

    return {
      status: result.posted ? 'handled' : 'pending',
      reason: result.posted ? 'posted' : result.reason,
      pendingJobs: input.pendingJobs.length,
      runpodJobId: result.runpodJobId ?? pendingJob.runpodJobId,
      runpodStatus: result.runpodStatus ?? status.status,
      result,
    }
  }

  return {
    status: input.pendingJobs.length > 0 ? 'pending' : 'skipped',
    reason:
      input.pendingJobs.length > checked
        ? 'pending-runpod-check-limit-reached'
        : 'runpod-jobs-not-complete',
    pendingJobs: input.pendingJobs.length,
  }
}

async function executeScheduledLinkedInContent(
  env: Env,
  config: ScheduledLinkedInContentConfig,
  scheduledAt: Date,
) {
  const { contentHistoryRepository, loginRepository, postService } =
    await loadLinkedInServices(env)
  const runPodService = new RunPodLinkedInContentService(
    readRunPodLinkedInContentConfig(env),
  )
  const service = new PublishScheduledLinkedInContentService(
    loginRepository,
    postService,
    contentHistoryRepository,
    runPodService,
  )

  return service.execute(config, scheduledAt)
}

async function syncLinkedInPendingRunPodState(
  stateStore: ContentSchedulerStateStore,
  result: ScheduledLinkedInPostResult,
  previousPendingJob?: ScheduledRunPodPendingJob,
) {
  const runpodJobId = result.runpodJobId

  if (runpodJobId && shouldKeepPendingRunPodState(result)) {
    await stateStore.putPendingRunPodJob({
      module: LINKEDIN_MODULE,
      accountId: readResultAccountId(result),
      externalAccountId: readResultLinkedInMemberId(result),
      runpodJobId,
      runpodStatus: result.runpodStatus,
    })

    return
  }

  if (previousPendingJob) {
    await stateStore.deletePendingRunPodJob(previousPendingJob.key)
  }
}

function shouldKeepPendingRunPodState(result: ScheduledLinkedInPostResult) {
  if (!result.runpodJobId || result.posted) {
    return false
  }

  if (!result.runpodStatus) {
    return true
  }

  if (result.runpodStatus.startsWith('retrying:')) {
    return false
  }

  if (
    result.runpodStatus === 'DAILY_LIMIT_REACHED' ||
    result.runpodStatus === 'DEPENDENCY_UNAVAILABLE'
  ) {
    return false
  }

  return !isTerminalRunPodStatus(result.runpodStatus)
}

function readResultAccountId(result: ScheduledLinkedInPostResult) {
  return 'accountId' in result ? result.accountId : null
}

function readResultLinkedInMemberId(result: ScheduledLinkedInPostResult) {
  return 'linkedinMemberId' in result ? result.linkedinMemberId : null
}

function isIdleSchedulerTick(results: ScheduledContentModuleResult[]) {
  return results.every(
    (result) =>
      result.status === 'skipped' &&
      (result.reason === 'schedule-off' ||
        result.reason === 'no-due-work-or-pending-runpod-job'),
  )
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

function shouldHandleLinkedInSchedulerTick(
  config: ScheduledLinkedInContentConfig,
  scheduledAt: Date,
) {
  if (config.schedule === 'off') {
    return false
  }

  if (shouldRun(config.schedule, scheduledAt)) {
    return true
  }

  return false
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

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'Scheduled content module failed'
}
