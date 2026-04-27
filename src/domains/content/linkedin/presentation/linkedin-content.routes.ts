import { Hono } from 'hono'
import type { Context } from 'hono'

import type { AppEnv } from '../../../../app/types'
import { loadLinkedInServices } from '../../../linkedin/infrastructure/load-linkedin-services'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInVisibility,
} from '../../../linkedin/domain/linkedin.entities'
import { badRequest } from '../../../../shared/http/errors'
import {
  getBearerToken,
  parseJsonObject,
  parseOptionalJsonObject,
} from '../../../../shared/http/request'
import {
  LinkedInAutomationService,
  readLinkedInAutomationStatus,
  toAutomationResult,
} from '../application/linkedin-automation.service'
import { CreateLinkedInContentService } from '../application/create-linkedin-content.service'
import {
  canPublishWithLinkedInAccount,
  LinkedInPublishingSessionService,
} from '../application/linkedin-publishing-session.service'
import {
  readLinkedInContentPool,
  readLinkedInContentSections,
  readLinkedInMemeSubreddits,
  readLinkedInRedditSubreddits,
  type LinkedInContentEngineInput,
} from '../application/linkedin-content-engine.service'
import {
  PublishLinkedInContentService,
  type LinkedInContentPublishInput,
} from '../application/publish-linkedin-content.service'
import {
  PublishSingleLinkedInAiContentService,
  type PublishSingleLinkedInAiContentInput,
} from '../application/publish-single-linkedin-ai-content.service'
import {
  readRunPodLinkedInContentConfig,
  RunPodLinkedInContentService,
} from '../application/runpod-linkedin-content.service'
import {
  readLinkedInNewsCardImageInputFromUrl,
  renderLinkedInNewsCardImage,
} from '../application/linkedin-news-card-image.service'
import type {
  LinkedInContentInput,
  LinkedInContentTone,
} from '../domain/linkedin-content.entity'

type LinkedInContentBody = {
  topic?: unknown
  audience?: unknown
  objective?: unknown
  keyPoints?: unknown
  tone?: unknown
  callToAction?: unknown
  articleUrl?: unknown
  articleTitle?: unknown
  articleDescription?: unknown
  imageUrl?: unknown
  imageTitle?: unknown
  imageDescription?: unknown
  imageAltText?: unknown
  visibility?: unknown
  accountId?: unknown
  linkedinMemberId?: unknown
  status?: unknown
  section?: unknown
  sourceUrl?: unknown
  forceNew?: unknown
}

type LinkedInAutoPostEnv = Env & {
  CONTENT_LINKEDIN_AUTO_POST_SECTIONS?: string
  CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL?: string
  CONTENT_LINKEDIN_MEME_SUBREDDITS?: string
  CONTENT_LINKEDIN_REDDIT_SUBREDDITS?: string
  CONTENT_LINKEDIN_REDDIT_USER_AGENT?: string
}

export function createLinkedInContentRouter() {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    return c.json({
      ok: true,
      domain: 'content',
      platform: 'linkedin',
      description: 'LinkedIn-specific content creation and publishing workflows',
      endpoints: {
        status: '/api/content/linkedin/status',
        automation: '/api/content/linkedin/automation',
        automationStatus: '/api/content/linkedin/automation/status',
        automationStart: '/api/content/linkedin/automation/start',
        automationStop: '/api/content/linkedin/automation/stop',
        drafts: '/api/content/linkedin/drafts',
        posts: '/api/content/linkedin/posts',
        singleAiPost: '/api/content/linkedin/posts/single',
        newsCardImage: '/api/content/linkedin/news-card.png',
      },
      requestId: c.get('requestId'),
    })
  })

  router.get('/news-card.png', async (c) => {
    const png = await renderLinkedInNewsCardImage(
      readLinkedInNewsCardImageInputFromUrl(new URL(c.req.url)),
    )

    return new Response(png, {
      headers: {
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': 'image/png',
      },
    })
  })

  router.get('/status', async (c) => {
    const { dashboardService } = await loadLinkedInServices(c.env)
    const dashboard = await dashboardService.getDashboard(
      readLinkedInAccountLookupFromQuery(c),
    )

    return c.json({
      ok: true,
      domain: 'content',
      platform: 'linkedin',
      connected: dashboard.connected,
      canPublish: canPublishWithLinkedInAccount(dashboard),
      account: dashboard.account,
      automation: dashboard.account ? toAutomationResult(dashboard.account) : null,
      validations: {
        connected: dashboard.connected,
        accessTokenActive: dashboard.account
          ? !dashboard.account.accessTokenExpired
          : false,
        hasPostingPermission:
          dashboard.account?.scopes.includes('w_member_social') ?? false,
      },
      requestId: c.get('requestId'),
    })
  })

  router.get('/automation', async (c) => {
    return handleLinkedInAutomationRead(c)
  })

  router.get('/automation/status', async (c) => {
    return handleLinkedInAutomationRead(c)
  })

  router.post('/automation/status', async (c) => {
    const body = await parseJsonObject<LinkedInContentBody>(c.req.raw)
    const status = readLinkedInAutomationStatus(body.status)

    return handleLinkedInAutomationUpdate(c, status, body)
  })

  router.post('/automation/start', async (c) => {
    const body = await readOptionalLinkedInContentBody(c)

    return handleLinkedInAutomationUpdate(c, 'start', body)
  })

  router.post('/automation/stop', async (c) => {
    const body = await readOptionalLinkedInContentBody(c)

    return handleLinkedInAutomationUpdate(c, 'stop', body)
  })

  router.post('/drafts', async (c) => {
    const body = await parseJsonObject<LinkedInContentBody>(c.req.raw)
    const service = new CreateLinkedInContentService()
    const draft = service.execute(readLinkedInContentInput(body))

    return c.json({
      ok: true,
      domain: 'content',
      platform: 'linkedin',
      draft,
      requestId: c.get('requestId'),
    })
  })

  router.post('/posts', async (c) => {
    const body = await parseJsonObject<LinkedInContentBody>(c.req.raw)
    const accessToken = getBearerToken(c.req.header('Authorization'))
    const { loginRepository, postService } = await loadLinkedInServices(c.env)
    const sessionService = new LinkedInPublishingSessionService(loginRepository)
    const account = await sessionService.requirePublishableAccount(
      readLinkedInAccountLookupFromBody(body),
    )
    const contentService = new CreateLinkedInContentService()
    const publishService = new PublishLinkedInContentService(
      contentService,
      postService,
    )
    const result = await publishService.publish(
      accessToken,
      readLinkedInContentPublishInput(body),
      {
        expectedLinkedInMemberId: account.linkedinMemberId,
      },
    )

    return c.json(
      {
        ok: true,
        domain: 'content',
        platform: 'linkedin',
        action: 'create-and-publish',
        ...result,
        requestId: c.get('requestId'),
      },
      201,
    )
  })

  router.post('/posts/single', async (c) => {
    return handleSingleLinkedInAiPost(c)
  })

  router.post('/single-post', async (c) => {
    return handleSingleLinkedInAiPost(c)
  })

  return router
}

async function handleSingleLinkedInAiPost(c: Context<AppEnv>) {
  const body = await readOptionalLinkedInContentBody(c)
  const accessToken = getBearerToken(c.req.header('Authorization'))
  const {
    contentHistoryRepository,
    loginRepository,
    postService,
  } = await loadLinkedInServices(c.env)
  const sessionService = new LinkedInPublishingSessionService(loginRepository)
  const account = await sessionService.requirePublishableAccount(
    readLinkedInAccountLookupFromBody(body),
  )
  const runPodService = new RunPodLinkedInContentService(
    readRunPodLinkedInContentConfig(c.env),
  )
  const service = new PublishSingleLinkedInAiContentService(
    postService,
    contentHistoryRepository,
    runPodService,
  )
  const input = readSingleLinkedInAiPostInput(
    c.env,
    body,
    accessToken,
    account,
    readPublicBaseUrlFromRequest(c),
  )
  const result = await service.execute(input)

  return c.json(
    {
      ok: result.posted,
      domain: 'content',
      platform: 'linkedin',
      action: 'single-ai-post',
      ...result,
      requestId: c.get('requestId'),
    },
    result.posted ? 201 : 202,
  )
}

async function handleLinkedInAutomationRead(c: Context<AppEnv>) {
  const { dashboardService } = await loadLinkedInServices(c.env)
  const dashboard = await dashboardService.getDashboard(
    readLinkedInAccountLookupFromQuery(c),
  )

  return c.json({
    ok: true,
    domain: 'content',
    platform: 'linkedin',
    automation: dashboard.account ? toAutomationResult(dashboard.account) : null,
    connected: dashboard.connected,
    canPublish: canPublishWithLinkedInAccount(dashboard),
    requestId: c.get('requestId'),
  })
}

async function handleLinkedInAutomationUpdate(
  c: Context<AppEnv>,
  status: 'start' | 'stop',
  body: LinkedInContentBody,
) {
  const accessToken = getBearerToken(c.req.header('Authorization'))
  const { loginRepository, profileService } = await loadLinkedInServices(c.env)
  const service = new LinkedInAutomationService(
    loginRepository,
    profileService,
  )
  const lookup = readLinkedInAccountLookupFromBody(body)
  const input: {
    accessToken: string
    status: 'start' | 'stop'
    lookup?: FindLinkedInStoredAccountInput
  } = {
    accessToken,
    status,
  }

  if (lookup) {
    input.lookup = lookup
  }

  const automation = await service.updateStatus(input)

  return c.json({
    ok: true,
    domain: 'content',
    platform: 'linkedin',
    action: status === 'start' ? 'automation-start' : 'automation-stop',
    automation,
    requestId: c.get('requestId'),
  })
}

async function readOptionalLinkedInContentBody(c: Context<AppEnv>) {
  return (
    (await parseOptionalJsonObject<LinkedInContentBody>(c.req.raw)) ?? {}
  )
}

function readLinkedInAccountLookupFromQuery(c: Context<AppEnv>) {
  const lookup: FindLinkedInStoredAccountInput = {}
  const accountId = c.req.query('accountId')?.trim()
  const linkedinMemberId = c.req.query('linkedinMemberId')?.trim()

  if (accountId) {
    lookup.accountId = accountId
  }

  if (linkedinMemberId) {
    lookup.linkedinMemberId = linkedinMemberId
  }

  return Object.keys(lookup).length === 0 ? undefined : lookup
}

function readLinkedInAccountLookupFromBody(body: LinkedInContentBody) {
  const lookup: FindLinkedInStoredAccountInput = {}
  const accountId = readOptionalString(body, 'accountId')?.trim()
  const linkedinMemberId = readOptionalString(body, 'linkedinMemberId')?.trim()

  if (accountId) {
    lookup.accountId = accountId
  }

  if (linkedinMemberId) {
    lookup.linkedinMemberId = linkedinMemberId
  }

  return Object.keys(lookup).length === 0 ? undefined : lookup
}

function readLinkedInContentPublishInput(body: LinkedInContentBody) {
  const input: LinkedInContentPublishInput = readLinkedInContentInput(body)
  const articleUrl = readOptionalString(body, 'articleUrl')
  const articleTitle = readOptionalString(body, 'articleTitle')
  const articleDescription = readOptionalString(body, 'articleDescription')
  const imageUrl = readOptionalString(body, 'imageUrl')
  const imageTitle = readOptionalString(body, 'imageTitle')
  const imageDescription = readOptionalString(body, 'imageDescription')
  const imageAltText = readOptionalString(body, 'imageAltText')
  const visibility = readOptionalString(body, 'visibility')

  if (articleUrl !== undefined) {
    input.articleUrl = articleUrl
  }

  if (articleTitle !== undefined) {
    input.articleTitle = articleTitle
  }

  if (articleDescription !== undefined) {
    input.articleDescription = articleDescription
  }

  if (imageUrl !== undefined) {
    input.imageUrl = imageUrl
  }

  if (imageTitle !== undefined) {
    input.imageTitle = imageTitle
  }

  if (imageDescription !== undefined) {
    input.imageDescription = imageDescription
  }

  if (imageAltText !== undefined) {
    input.imageAltText = imageAltText
  }

  if (visibility !== undefined) {
    input.visibility = visibility as LinkedInVisibility
  }

  return input
}

function readSingleLinkedInAiPostInput(
  env: Env,
  body: LinkedInContentBody,
  accessToken: string,
  account: PublishSingleLinkedInAiContentInput['account'],
  publicBaseUrl: string,
): PublishSingleLinkedInAiContentInput {
  const imageUrl = readOptionalString(body, 'imageUrl')?.trim()
  const section = readOptionalString(body, 'section')?.trim()
  const sourceUrl =
    readOptionalString(body, 'sourceUrl')?.trim() ??
    readOptionalString(body, 'articleUrl')?.trim()
  const visibility = readOptionalString(body, 'visibility')?.trim()
  const input: PublishSingleLinkedInAiContentInput = {
    accessToken,
    account,
    contentEngine: readLinkedInContentEngineInput(env, publicBaseUrl),
  }
  const contentOverrides = readLinkedInContentPublishOverrides(body)

  if (contentOverrides) {
    input.contentOverrides = contentOverrides
  }

  if (imageUrl) {
    input.imageUrl = imageUrl
  }

  if (section) {
    input.section = section
  }

  if (sourceUrl) {
    input.sourceUrl = sourceUrl
  }

  if (visibility) {
    input.visibility = visibility as LinkedInVisibility
  }

  const forceNew = readOptionalBoolean(body, 'forceNew')

  if (forceNew !== undefined) {
    input.forceNew = forceNew
  }

  return input
}

function readLinkedInContentPublishOverrides(
  body: LinkedInContentBody,
): PublishSingleLinkedInAiContentInput['contentOverrides'] {
  const overrides: NonNullable<
    PublishSingleLinkedInAiContentInput['contentOverrides']
  > = {}
  const topic = readOptionalString(body, 'topic')
  const audience = readOptionalString(body, 'audience')
  const objective = readOptionalString(body, 'objective')
  const keyPoints = readOptionalStringArray(body, 'keyPoints')
  const tone = readOptionalString(body, 'tone')
  const callToAction = readOptionalString(body, 'callToAction')
  const articleUrl = readOptionalString(body, 'articleUrl')
  const articleTitle = readOptionalString(body, 'articleTitle')
  const articleDescription = readOptionalString(body, 'articleDescription')
  const imageTitle = readOptionalString(body, 'imageTitle')
  const imageDescription = readOptionalString(body, 'imageDescription')
  const imageAltText = readOptionalString(body, 'imageAltText')
  const visibility = readOptionalString(body, 'visibility')

  if (topic !== undefined) {
    overrides.topic = topic
  }

  if (audience !== undefined) {
    overrides.audience = audience
  }

  if (objective !== undefined) {
    overrides.objective = objective
  }

  if (keyPoints !== undefined) {
    overrides.keyPoints = keyPoints
  }

  if (tone !== undefined) {
    overrides.tone = tone as LinkedInContentTone
  }

  if (callToAction !== undefined) {
    overrides.callToAction = callToAction
  }

  if (articleUrl !== undefined) {
    overrides.articleUrl = articleUrl
  }

  if (articleTitle !== undefined) {
    overrides.articleTitle = articleTitle
  }

  if (articleDescription !== undefined) {
    overrides.articleDescription = articleDescription
  }

  if (imageTitle !== undefined) {
    overrides.imageTitle = imageTitle
  }

  if (imageDescription !== undefined) {
    overrides.imageDescription = imageDescription
  }

  if (imageAltText !== undefined) {
    overrides.imageAltText = imageAltText
  }

  if (visibility !== undefined) {
    overrides.visibility = visibility as LinkedInVisibility
  }

  return Object.keys(overrides).length === 0 ? undefined : overrides
}

function readLinkedInContentEngineInput(
  env: Env,
  publicBaseUrl?: string,
): LinkedInContentEngineInput {
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

  if (publicBaseUrl) {
    engineInput.publicBaseUrl = publicBaseUrl
  }

  return engineInput
}

function readPublicBaseUrlFromRequest(c: Context<AppEnv>) {
  return new URL(c.req.url).origin
}

function readLinkedInContentInput(body: LinkedInContentBody): LinkedInContentInput {
  const topic = readOptionalString(body, 'topic')

  if (topic === undefined) {
    throw badRequest('topic is required')
  }

  const input: LinkedInContentInput = {
    topic,
  }
  const audience = readOptionalString(body, 'audience')
  const objective = readOptionalString(body, 'objective')
  const keyPoints = readOptionalStringArray(body, 'keyPoints')
  const tone = readOptionalString(body, 'tone')
  const callToAction = readOptionalString(body, 'callToAction')

  if (audience !== undefined) {
    input.audience = audience
  }

  if (objective !== undefined) {
    input.objective = objective
  }

  if (keyPoints !== undefined) {
    input.keyPoints = keyPoints
  }

  if (tone !== undefined) {
    input.tone = tone as LinkedInContentTone
  }

  if (callToAction !== undefined) {
    input.callToAction = callToAction
  }

  return input
}

function readOptionalString(body: LinkedInContentBody, key: keyof LinkedInContentBody) {
  const value = body[key]

  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw badRequest(`${key} must be a string`)
  }

  return value
}

function readOptionalStringArray(
  body: LinkedInContentBody,
  key: keyof LinkedInContentBody,
) {
  const value = body[key]

  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw badRequest(`${key} must be an array of strings`)
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw badRequest(`${key}[${index}] must be a string`)
    }

    return item
  })
}

function readOptionalBoolean(
  body: LinkedInContentBody,
  key: keyof LinkedInContentBody,
) {
  const value = body[key]

  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw badRequest(`${key} must be a boolean`)
  }

  return value
}
