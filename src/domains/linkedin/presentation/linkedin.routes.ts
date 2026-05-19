import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { AppEnv } from '../../../app/types'
import { badRequest, unauthorized } from '../../../shared/http/errors'
import { getBearerToken, parseJsonObject } from '../../../shared/http/request'
import { LINKEDIN_CALLBACK_PATH } from '../linkedin.constants'
import type { LinkedInProfile } from '../domain/linkedin.entities'
import type { LinkedInVisibility } from '../domain/linkedin.entities'
import type { LinkedInLoginRepository } from '../domain/linkedin-login.repository'
import { loadLinkedInServices } from '../infrastructure/load-linkedin-services'
import {
  isAutofeedLinkedInSessionToken,
  type LinkedInAccountSessionService,
  type LinkedInAccountSessionScope,
} from '../application/linkedin-account-session.service'
import { LinkedInOAuthStateService } from '../application/linkedin-oauth-state.service'
import type { LinkedInProfileService } from '../application/linkedin-profile.service'

type LinkedInReturnUriEnv = Env & {
  LINKEDIN_ALLOWED_RETURN_URIS?: string
}

export async function handleLinkedInCallback(c: Context<AppEnv>) {
  const prefersHtml = readCallbackHtmlPreference(c)
  const error = c.req.query('error')
  const errorDescription = c.req.query('error_description')

  if (error) {
    const message = errorDescription || `LinkedIn authorization failed: ${error}`
    const callbackState = await readCallbackStateContext(c)

    if (prefersHtml) {
      if (callbackState?.returnUri) {
        logLinkedInCallbackComplete(c, {
          outcome: 'linkedin_error',
          status: 302,
          returnUri: callbackState.returnUri,
          oauthStatePresent: true,
          clientStatePresent: false,
          error,
        })

        return withPrivateResponseHeaders(
          c.redirect(
            buildLinkedInErrorReturnUri(callbackState.returnUri, {
              error,
              message,
              requestId: c.get('requestId'),
              state: callbackState.state,
            }),
            302,
          ),
        )
      }

      return renderLinkedInCallbackPage(c, {
        variant: 'error',
        title: 'LinkedIn sign-in hit a snag',
        message,
        eyebrow: 'Connection incomplete',
        actionLabel: 'Try again',
        actionHref: buildLinkedInAuthStartHref(c, callbackState?.returnUri),
      }, 400)
    }

    throw badRequest(message)
  }

  const code = c.req.query('code')?.trim()

  if (!code) {
    const callbackState = await readCallbackStateContext(c)

    if (prefersHtml) {
      if (callbackState?.returnUri) {
        logLinkedInCallbackComplete(c, {
          outcome: 'missing_code',
          status: 302,
          returnUri: callbackState.returnUri,
          oauthStatePresent: true,
          clientStatePresent: false,
          error: 'missing_code',
        })

        return withPrivateResponseHeaders(
          c.redirect(
            buildLinkedInErrorReturnUri(callbackState.returnUri, {
              error: 'missing_code',
              message:
                'LinkedIn redirected back without the authorization code we need to finish sign-in.',
              requestId: c.get('requestId'),
              state: callbackState.state,
            }),
            302,
          ),
        )
      }

      return renderLinkedInCallbackPage(c, {
        variant: 'error',
        title: 'Missing LinkedIn code',
        message: 'LinkedIn redirected back without the authorization code we need to finish sign-in.',
        eyebrow: 'Connection incomplete',
        actionLabel: 'Start over',
        actionHref: buildLinkedInAuthStartHref(c, callbackState?.returnUri),
      }, 400)
    }

    throw badRequest('LinkedIn callback requires a code query parameter')
  }

  try {
    const { accountSessionService, authService } =
      await loadLinkedInServices(c.env)
    const state = c.req.query('state') ?? null
    const result = await authService.handleCallback(code, {
      state,
      requestId: c.get('requestId'),
    })
    const session = await accountSessionService.createSession(
      result.storedAccount,
    )

    if (result.returnUri && prefersHtml) {
      logLinkedInCallbackComplete(c, {
        outcome: 'success',
        status: 302,
        returnUri: result.returnUri,
        oauthStatePresent: Boolean(state),
        clientStatePresent: Boolean(result.clientState),
        accountId: session.accountId,
      })

      return withPrivateResponseHeaders(
        c.redirect(
          buildLinkedInReturnUri(result.returnUri, {
            accountId: session.accountId,
            linkedinMemberId: session.linkedinMemberId,
            sessionToken: session.accessToken,
            sessionExpiresAt: session.expiresAt,
            state: result.clientState,
          }),
          302,
        ),
      )
    }

    if (prefersHtml) {
      return renderLinkedInCallbackPage(c, {
        variant: 'success',
        title: 'LinkedIn connected',
        message: result.profile.name
          ? `${result.profile.name} is connected and saved to Autofeed for future publishing.`
          : 'Your LinkedIn account is connected and saved to Autofeed for future use.',
        eyebrow: 'Connection complete',
        profile: result.profile,
        actionLabel: 'Close this tab',
      })
    }

    const response = c.json({
      ok: true,
      domain: 'linkedin',
      action: 'callback',
      state: result.clientState,
      profile: result.profile,
      storedAccount: result.storedAccount,
      session,
      requestId: c.get('requestId'),
    })

    return withPrivateResponseHeaders(response)
  } catch (error) {
    if (!prefersHtml) {
      throw error
    }

    const callbackState = await readCallbackStateContext(c)
    const status = error instanceof HTTPException ? error.status : 500
    const message = getPublicLinkedInCallbackErrorMessage(error)

    if (callbackState?.returnUri) {
      logLinkedInCallbackComplete(c, {
        outcome: 'callback_failed',
        status: 302,
        returnUri: callbackState.returnUri,
        oauthStatePresent: true,
        clientStatePresent: false,
        error: error instanceof Error ? error.name : 'Error',
      })

      return withPrivateResponseHeaders(
        c.redirect(
          buildLinkedInErrorReturnUri(callbackState.returnUri, {
            error: 'linkedin_callback_failed',
            message,
            requestId: c.get('requestId'),
            state: callbackState.state,
          }),
          302,
        ),
      )
    }

    return renderLinkedInCallbackPage(c, {
      variant: 'error',
      title: 'LinkedIn sign-in did not finish',
      message,
      eyebrow: 'Connection incomplete',
      actionLabel: 'Try again',
      actionHref: buildLinkedInAuthStartHref(c, callbackState?.returnUri),
    }, status)
  }
}

export function createLinkedInRouter() {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    return c.json({
      ok: true,
      domain: 'linkedin',
      description: 'LinkedIn auth, callback, profile, and posting APIs',
      endpoints: {
        authStart: '/api/linkedin/auth-start',
        login: '/api/linkedin/login',
        auth: '/api/linkedin/auth',
        start: '/api/linkedin/start',
        authorize: '/api/linkedin/authorize',
        connect: '/api/linkedin/connect',
        dashboard: '/api/linkedin/dashboard',
        authorizationUrl: '/api/linkedin/authorization-url',
        authorizationUrlLegacy: '/api/linkedin/authorizationUrl',
        authorizationCallback: LINKEDIN_CALLBACK_PATH,
        profile: '/api/linkedin/profile',
        posts: '/api/linkedin/posts',
      },
      requestId: c.get('requestId'),
    })
  })

  registerLinkedInAuthRoute(router, '/auth-start')
  registerLinkedInAuthRoute(router, '/login')
  registerLinkedInAuthRoute(router, '/auth')
  registerLinkedInAuthRoute(router, '/start')
  registerLinkedInAuthRoute(router, '/authorize')
  registerLinkedInAuthRoute(router, '/connect')
  registerLinkedInAuthRoute(router, '/authorization-url', { preferJson: true })
  registerLinkedInAuthRoute(router, '/authorizationUrl', { preferJson: true })

  router.get('/dashboard', async (c) => {
    const { accountSessionService, dashboardService } =
      await loadLinkedInServices(c.env)
    const accountId = readOptionalQueryValue(c, 'accountId')
    const linkedinMemberId = readOptionalQueryValue(c, 'linkedinMemberId')
    const lookup: {
      accountId?: string
      linkedinMemberId?: string
    } = {}

    if (accountId) {
      lookup.accountId = accountId
    }

    if (linkedinMemberId) {
      lookup.linkedinMemberId = linkedinMemberId
    }

    const sessionInput: {
      authorizationHeader: string | null
      lookup?: typeof lookup
      requiredScope: 'linkedin:automation'
    } = {
      authorizationHeader: c.req.header('Authorization') ?? null,
      requiredScope: 'linkedin:automation',
    }

    if (Object.keys(lookup).length > 0) {
      sessionInput.lookup = lookup
    }

    const session = await accountSessionService.requireSession(sessionInput)
    const dashboard = await dashboardService.getDashboard(
      {
        accountId: session.accountId,
        linkedinMemberId: session.linkedinMemberId,
      },
    )

    return c.json({
      ok: true,
      domain: 'linkedin',
      dashboard,
      requestId: c.get('requestId'),
    })
  })

  router.get('/profile', async (c) => {
    const { accountSessionService, loginRepository, profileService } =
      await loadLinkedInServices(c.env)
    const accessToken = getBearerToken(c.req.header('Authorization'))
    const profile = isAutofeedLinkedInSessionToken(accessToken)
      ? await getProfileForAutofeedSession({
          accountSessionService,
          loginRepository,
          profileService,
          token: accessToken,
        })
      : await profileService.getCurrentProfile(accessToken)

    return c.json({
      ok: true,
      domain: 'linkedin',
      profile,
      requestId: c.get('requestId'),
    })
  })

  router.post('/posts', async (c) => {
    const { accountSessionService, loginRepository, postService } =
      await loadLinkedInServices(c.env)
    const accessToken = getBearerToken(c.req.header('Authorization'))
    const body = await parseJsonObject<{
      text?: unknown
      articleUrl?: unknown
      articleTitle?: unknown
      articleDescription?: unknown
      imageUrl?: unknown
      imageTitle?: unknown
      imageDescription?: unknown
      imageAltText?: unknown
      visibility?: unknown
    }>(c.req.raw)

    const postInput: {
      text: string
      articleUrl?: string
      articleTitle?: string
      articleDescription?: string
      imageUrl?: string
      imageTitle?: string
      imageDescription?: string
      imageAltText?: string
      visibility?: LinkedInVisibility
    } = {
      text: typeof body.text === 'string' ? body.text : '',
    }

    if (typeof body.articleUrl === 'string') {
      postInput.articleUrl = body.articleUrl
    }

    if (typeof body.articleTitle === 'string') {
      postInput.articleTitle = body.articleTitle
    }

    if (typeof body.articleDescription === 'string') {
      postInput.articleDescription = body.articleDescription
    }

    if (typeof body.imageUrl === 'string') {
      postInput.imageUrl = body.imageUrl
    }

    if (typeof body.imageTitle === 'string') {
      postInput.imageTitle = body.imageTitle
    }

    if (typeof body.imageDescription === 'string') {
      postInput.imageDescription = body.imageDescription
    }

    if (typeof body.imageAltText === 'string') {
      postInput.imageAltText = body.imageAltText
    }

    if (typeof body.visibility === 'string') {
      postInput.visibility = body.visibility as LinkedInVisibility
    }

    const publishSession = isAutofeedLinkedInSessionToken(accessToken)
      ? await readPublishSessionForAutofeedSession(c, {
          accountSessionService,
          loginRepository,
          token: accessToken,
        })
      : {
          accessToken,
          linkedinMemberId: undefined,
        }
    const post = await postService.publish(
      publishSession.accessToken,
      postInput,
      publishSession.linkedinMemberId
        ? {
            expectedLinkedInMemberId: publishSession.linkedinMemberId,
          }
        : undefined,
    )

    return c.json(
      {
        ok: true,
        domain: 'linkedin',
        post,
        requestId: c.get('requestId'),
      },
      201,
    )
  })

  return router
}

function registerLinkedInAuthRoute(
  router: Hono<AppEnv>,
  path: string,
  options?: {
    preferJson?: boolean
  },
) {
  router.get(path, (c) => {
    return handleLinkedInAuthStart(c, options)
  })

  router.post(path, (c) => {
    return handleLinkedInAuthStart(c, {
      preferJson: true,
      ...options,
    })
  })
}

async function handleLinkedInAuthStart(
  c: Context<AppEnv>,
  options?: {
    preferJson?: boolean
  },
) {
  const { authService } = await loadLinkedInServices(c.env)
  const input = await readAuthStartInput(c)
  const loginOptions: {
    state?: string
    scopes?: string[]
    returnUri?: string
  } = {}

  if (input.state) {
    loginOptions.state = input.state
  }

  if (input.scopes) {
    loginOptions.scopes = input.scopes
  }

  const returnUri = readAllowedLinkedInReturnUri(c, input.returnUri)

  if (returnUri) {
    loginOptions.returnUri = returnUri
  }

  const login = await authService.createLogin(loginOptions)
  const shouldRedirect = readRedirectPreference(c, options)

  if (shouldRedirect) {
    return c.redirect(login.authorizationUrl, 302)
  }

  return c.json({
    ok: true,
    domain: 'linkedin',
    action: 'auth-start',
    url: login.authorizationUrl,
    ...login,
    requestId: c.get('requestId'),
  })
}

async function getProfileForAutofeedSession(
  input: {
    accountSessionService: LinkedInAccountSessionService
    loginRepository: LinkedInLoginRepository | null
    profileService: LinkedInProfileService
    token: string
  },
) {
  const publishSession = await readStoredLinkedInTokenForAutofeedSession({
    accountSessionService: input.accountSessionService,
    loginRepository: input.loginRepository,
    token: input.token,
    requiredScope: 'linkedin:automation',
  })

  return input.profileService.getCurrentProfile(publishSession.accessToken)
}

async function readPublishSessionForAutofeedSession(
  _c: Context<AppEnv>,
  input: {
    accountSessionService: LinkedInAccountSessionService
    loginRepository: LinkedInLoginRepository | null
    token: string
  },
) {
  return readStoredLinkedInTokenForAutofeedSession({
    accountSessionService: input.accountSessionService,
    loginRepository: input.loginRepository,
    token: input.token,
    requiredScope: 'linkedin:publish',
  })
}

async function readStoredLinkedInTokenForAutofeedSession(
  input: {
    accountSessionService: LinkedInAccountSessionService
    loginRepository: LinkedInLoginRepository | null
    token: string
    requiredScope: LinkedInAccountSessionScope
  },
) {
  const session = await input.accountSessionService.requireSession({
    token: input.token,
    requiredScope: input.requiredScope,
  })

  if (!input.loginRepository) {
    throw unauthorized('LinkedIn account is not connected')
  }

  const account = await input.loginRepository.findPublishableAccount({
    accountId: session.accountId,
    linkedinMemberId: session.linkedinMemberId,
  })

  if (!account) {
    throw unauthorized('LinkedIn account is not connected')
  }

  return {
    accessToken: account.accessToken,
    linkedinMemberId: account.linkedinMemberId,
  }
}

function readRedirectPreference(
  c: Context<AppEnv>,
  options?: {
    preferJson?: boolean
  },
) {
  const redirect = c.req.query('redirect')

  if (redirect === 'true') {
    return true
  }

  if (redirect === 'false') {
    return false
  }

  return readHtmlPreference(c, !options?.preferJson)
}

function readCallbackHtmlPreference(c: Context<AppEnv>) {
  const format = c.req.query('format')?.trim().toLowerCase()

  if (format === 'html') {
    return true
  }

  if (format === 'json') {
    return false
  }

  return readHtmlPreference(c, false)
}

function readOptionalQueryValue(c: Context<AppEnv>, key: string) {
  const value = c.req.query(key)?.trim()

  return value ? value : undefined
}

function readHtmlPreference(c: Context<AppEnv>, fallback: boolean) {
  const secFetchMode = c.req.header('Sec-Fetch-Mode')

  if (secFetchMode) {
    return secFetchMode === 'navigate'
  }

  const secFetchDest = c.req.header('Sec-Fetch-Dest')

  if (secFetchDest === 'document' || secFetchDest === 'iframe') {
    return true
  }

  const accept = c.req.header('Accept') ?? ''

  if (accept.includes('application/json') || accept.includes('*/*')) {
    return false
  }

  if (
    accept.includes('text/html') ||
    accept.includes('application/xhtml+xml')
  ) {
    return true
  }

  return fallback
}

async function readAuthStartInput(c: Context<AppEnv>) {
  const queryState = c.req.query('state') ?? undefined
  const queryScopes = readScopeQuery(c)
  const queryReturnUri =
    c.req.query('returnUri') ??
    c.req.query('redirectUri') ??
    c.req.query('return_uri') ??
    undefined

  if (c.req.method !== 'POST') {
    return {
      state: queryState,
      scopes: queryScopes,
      returnUri: queryReturnUri,
    }
  }

  const body = await readOptionalJsonObject(c.req.raw)
  const bodyState =
    typeof body?.state === 'string' ? body.state.trim() || undefined : undefined
  const bodyScopes = readScopeBody(body)
  const bodyReturnUri = readReturnUriBody(body)

  return {
    state: bodyState ?? queryState,
    scopes: bodyScopes ?? queryScopes,
    returnUri: bodyReturnUri ?? queryReturnUri,
  }
}

function readScopeQuery(c: Context<AppEnv>) {
  const url = new URL(c.req.url)
  const params = url.searchParams.getAll('scope')

  if (params.length === 0) {
    return undefined
  }

  return params.flatMap((scope) =>
    scope
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function readScopeBody(body: Record<string, unknown> | null) {
  if (!body) {
    return undefined
  }

  const rawScopes =
    'scopes' in body
      ? body.scopes
      : 'scope' in body
        ? body.scope
        : undefined

  if (typeof rawScopes === 'string') {
    return rawScopes
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  }

  if (Array.isArray(rawScopes)) {
    return rawScopes
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
  }

  return undefined
}

function readReturnUriBody(body: Record<string, unknown> | null) {
  if (!body) {
    return undefined
  }

  const rawReturnUri =
    'returnUri' in body
      ? body.returnUri
      : 'redirectUri' in body
        ? body.redirectUri
        : 'return_uri' in body
          ? body.return_uri
          : undefined

  return typeof rawReturnUri === 'string'
    ? rawReturnUri.trim() || undefined
    : undefined
}

function readAllowedLinkedInReturnUri(
  c: Context<AppEnv>,
  rawReturnUri?: string,
) {
  const returnUri = rawReturnUri?.trim()

  if (!returnUri) {
    return undefined
  }

  let parsed: URL

  try {
    parsed = new URL(returnUri)
  } catch {
    throw badRequest('returnUri must be a valid absolute URI')
  }

  const normalized = parsed.toString()
  const allowed = readAllowedReturnUris(c.env)

  if (!allowed.has(normalized)) {
    throw badRequest('returnUri is not allowed')
  }

  return normalized
}

function readAllowedReturnUris(env: Env) {
  const configured = (env as LinkedInReturnUriEnv)
    .LINKEDIN_ALLOWED_RETURN_URIS
    ?.split(/[,\s|]+/)
    .map((value) => value.trim())
    .filter(Boolean)

  return new Set([
    'com.autofeed.linkedin://oauthredirect',
    'autofeed://linkedin/oauthredirect',
    ...(configured ?? []),
  ])
}

async function readCallbackStateContext(c: Context<AppEnv>) {
  const state = c.req.query('state')?.trim()

  if (!state) {
    return null
  }

  try {
    const oauthState = await LinkedInOAuthStateService.fromEnv(c.env).verify(
      state,
    )

    return {
      state,
      returnUri: oauthState.returnUri,
    }
  } catch {
    return null
  }
}

function buildLinkedInAuthStartHref(
  c: Context<AppEnv>,
  returnUri?: string | null,
) {
  const url = new URL('/api/linkedin/auth-start', c.req.url)

  url.searchParams.set('redirect', 'true')

  if (returnUri) {
    url.searchParams.set('returnUri', returnUri)
  }

  return url.toString()
}

function buildLinkedInReturnUri(
  returnUri: string,
  input: {
    accountId: string
    linkedinMemberId: string
    sessionToken: string
    sessionExpiresAt: string
    state: string | null
  },
) {
  const url = new URL(returnUri)
  const params = new URLSearchParams(url.hash.replace(/^#/, ''))

  params.set('connected', 'true')
  params.set('accountId', input.accountId)
  params.set('linkedinMemberId', input.linkedinMemberId)
  params.set('autofeedSessionToken', input.sessionToken)
  params.set('autofeedSessionExpiresAt', input.sessionExpiresAt)

  if (input.state) {
    params.set('state', input.state)
  }

  url.hash = params.toString()

  return url.toString()
}

function buildLinkedInErrorReturnUri(
  returnUri: string,
  input: {
    error: string
    message: string
    requestId: string
    state: string | null
  },
) {
  const url = new URL(returnUri)
  const params = new URLSearchParams(url.hash.replace(/^#/, ''))

  params.set('connected', 'false')
  params.set('error', input.error)
  params.set('error_description', input.message)
  params.set('requestId', input.requestId)

  if (input.state) {
    params.set('state', input.state)
  }

  url.hash = params.toString()

  return url.toString()
}

function getPublicLinkedInCallbackErrorMessage(error: unknown) {
  if (error instanceof HTTPException && error.message) {
    return error.message
  }

  return 'Something went wrong while finishing your LinkedIn sign-in.'
}

function logLinkedInCallbackComplete(
  c: Context<AppEnv>,
  input: {
    outcome: 'success' | 'linkedin_error' | 'missing_code' | 'callback_failed'
    status: number
    returnUri?: string | null
    oauthStatePresent: boolean
    clientStatePresent: boolean
    accountId?: string
    error?: string
  },
) {
  console.log(
    JSON.stringify({
      message: 'linkedin.callback.complete',
      requestId: c.get('requestId'),
      outcome: input.outcome,
      status: input.status,
      returnedToNative: Boolean(input.returnUri),
      returnUri: input.returnUri
        ? describeReturnUriForLogs(input.returnUri)
        : null,
      oauthStatePresent: input.oauthStatePresent,
      clientStatePresent: input.clientStatePresent,
      accountId: input.accountId ?? null,
      error: input.error ?? null,
    }),
  )
}

function describeReturnUriForLogs(returnUri: string) {
  try {
    const url = new URL(returnUri)

    return {
      protocol: url.protocol,
      host: url.host || null,
      pathname: url.pathname || null,
    }
  } catch {
    return {
      protocol: null,
      host: null,
      pathname: null,
    }
  }
}

async function readOptionalJsonObject(request: Request) {
  const body = await request.text()

  if (!body.trim()) {
    return null
  }

  let payload: unknown

  try {
    payload = JSON.parse(body) as unknown
  } catch {
    throw badRequest('Request body must be valid JSON')
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('Request body must be a JSON object')
  }

  return payload as Record<string, unknown>
}

function renderLinkedInCallbackPage(
  c: Context<AppEnv>,
  input: {
    variant: 'success' | 'error'
    title: string
    message: string
    eyebrow: string
    profile?: LinkedInProfile
    actionLabel: string
    actionHref?: string
  },
  status = 200,
) {
  const requestId = escapeHtml(c.get('requestId'))
  const title = escapeHtml(input.title)
  const message = escapeHtml(input.message)
  const eyebrow = escapeHtml(input.eyebrow)
  const profileName = escapeHtml(
    input.profile?.name ?? input.profile?.email ?? 'LinkedIn account',
  )
  const profileEmail = input.profile?.email
    ? escapeHtml(input.profile.email)
    : null
  const profilePicture = input.profile?.picture
    ? escapeHtml(input.profile.picture)
    : null
  const actionLabel = escapeHtml(input.actionLabel)
  const actionHref = input.actionHref ? escapeHtml(input.actionHref) : null
  const accent = input.variant === 'success' ? '#0d9488' : '#e36414'
  const accentSoft = input.variant === 'success' ? '#7dd3c7' : '#f7b267'
  const badgeText = input.variant === 'success' ? 'Live' : 'Attention'
  const icon =
    input.variant === 'success'
      ? '<div class="badge-icon"><span></span><span></span></div>'
      : '<div class="badge-icon badge-icon-error"><span></span><span></span></div>'
  const profileMarkup = input.profile
    ? `
      <div class="profile-card">
        ${
          profilePicture
            ? `<img class="avatar" src="${profilePicture}" alt="${profileName}" />`
            : '<div class="avatar avatar-fallback">in</div>'
        }
        <div class="profile-copy">
          <p class="profile-label">Connected account</p>
          <p class="profile-name">${profileName}</p>
          ${profileEmail ? `<p class="profile-email">${profileEmail}</p>` : ''}
        </div>
      </div>
    `
    : ''
  const actionMarkup = actionHref
    ? `<a class="action action-link" href="${actionHref}">${actionLabel}</a>`
    : `<button class="action action-button" type="button" onclick="window.close(); if (history.length > 1) history.back();">${actionLabel}</button>`
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --canvas: #f7f5ef;
        --ink: #182126;
        --muted: #516067;
        --panel: rgba(255, 255, 255, 0.72);
        --panel-border: rgba(24, 33, 38, 0.08);
        --accent: ${accent};
        --accent-soft: ${accentSoft};
        --shadow: 0 32px 80px rgba(24, 33, 38, 0.16);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(125, 211, 199, 0.4), transparent 36%),
          radial-gradient(circle at bottom right, rgba(247, 178, 103, 0.26), transparent 28%),
          linear-gradient(180deg, #f3efe4 0%, var(--canvas) 56%, #f5f7fb 100%);
        display: grid;
        place-items: center;
        padding: 24px;
      }

      body::before,
      body::after {
        content: "";
        position: fixed;
        inset: auto;
        width: 220px;
        height: 220px;
        border-radius: 42px;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.48), rgba(255, 255, 255, 0.06));
        border: 1px solid rgba(255, 255, 255, 0.36);
        transform: rotate(16deg);
        backdrop-filter: blur(10px);
        pointer-events: none;
      }

      body::before {
        top: 40px;
        right: -88px;
      }

      body::after {
        bottom: -92px;
        left: -72px;
      }

      .shell {
        width: min(100%, 460px);
        position: relative;
      }

      .shell::before {
        content: "";
        position: absolute;
        inset: -18px 24px auto;
        height: 12px;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent-soft), var(--accent));
        filter: blur(18px);
        opacity: 0.72;
      }

      .card {
        position: relative;
        overflow: hidden;
        border-radius: 30px;
        padding: 28px;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }

      .card::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(135deg, rgba(255, 255, 255, 0.58), transparent 54%),
          linear-gradient(180deg, transparent 0%, rgba(13, 148, 136, 0.05) 100%);
        pointer-events: none;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(24, 33, 38, 0.08);
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        position: relative;
        z-index: 1;
      }

      .badge-icon {
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #0f766e);
        position: relative;
        box-shadow: 0 10px 24px rgba(13, 148, 136, 0.28);
      }

      .badge-icon span {
        position: absolute;
        display: block;
        background: #f8fffd;
        border-radius: 999px;
      }

      .badge-icon span:first-child {
        width: 10px;
        height: 3px;
        left: 6px;
        top: 11px;
        transform: rotate(45deg);
      }

      .badge-icon span:last-child {
        width: 16px;
        height: 3px;
        left: 9px;
        top: 10px;
        transform: rotate(-45deg);
        transform-origin: left center;
      }

      .badge-icon-error {
        background: linear-gradient(135deg, var(--accent), #b45309);
        box-shadow: 0 10px 24px rgba(227, 100, 20, 0.28);
      }

      .badge-icon-error span:first-child,
      .badge-icon-error span:last-child {
        width: 12px;
        height: 3px;
        left: 6px;
        top: 11px;
        transform-origin: center;
      }

      .badge-icon-error span:first-child {
        transform: rotate(45deg);
      }

      .badge-icon-error span:last-child {
        transform: rotate(-45deg);
      }

      h1 {
        margin: 22px 0 12px;
        font-size: clamp(34px, 9vw, 48px);
        line-height: 0.94;
        letter-spacing: -0.06em;
        position: relative;
        z-index: 1;
      }

      .message {
        margin: 0;
        font-size: 18px;
        line-height: 1.6;
        color: var(--muted);
        position: relative;
        z-index: 1;
      }

      .profile-card {
        display: flex;
        gap: 14px;
        align-items: center;
        margin-top: 24px;
        padding: 16px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(24, 33, 38, 0.08);
        position: relative;
        z-index: 1;
      }

      .avatar {
        width: 64px;
        height: 64px;
        border-radius: 22px;
        object-fit: cover;
        background: #d8dee4;
        flex-shrink: 0;
      }

      .avatar-fallback {
        display: grid;
        place-items: center;
        font-weight: 700;
        text-transform: lowercase;
        color: white;
        background: linear-gradient(135deg, var(--accent), #163d4d);
      }

      .profile-label,
      .meta-label {
        margin: 0;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .profile-name {
        margin: 4px 0 0;
        font-size: 21px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }

      .profile-email {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .actions {
        display: flex;
        gap: 12px;
        margin-top: 28px;
        position: relative;
        z-index: 1;
      }

      .action {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
        transition: transform 160ms ease, box-shadow 160ms ease;
      }

      .action:active {
        transform: translateY(1px);
      }

      .action-button,
      .action-link {
        color: white;
        background: linear-gradient(135deg, var(--accent), #163d4d);
        box-shadow: 0 16px 34px rgba(22, 61, 77, 0.22);
      }

      .meta {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin-top: 28px;
        padding-top: 18px;
        border-top: 1px solid rgba(24, 33, 38, 0.08);
        color: var(--muted);
        font-size: 13px;
        position: relative;
        z-index: 1;
      }

      .meta strong {
        display: block;
        margin-top: 4px;
        color: var(--ink);
        font-weight: 600;
      }

      .pulse {
        position: absolute;
        inset: auto -30px -42px auto;
        width: 150px;
        height: 150px;
        border-radius: 999px;
        background: radial-gradient(circle, rgba(125, 211, 199, 0.44), transparent 62%);
        opacity: 0.72;
        pointer-events: none;
      }

      @media (max-width: 480px) {
        .card {
          padding: 24px 20px;
          border-radius: 26px;
        }

        .meta {
          flex-direction: column;
        }

        .actions {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card">
        <div class="badge">
          ${icon}
          <span>${eyebrow}</span>
          <span>${badgeText}</span>
        </div>
        <h1>${title}</h1>
        <p class="message">${message}</p>
        ${profileMarkup}
        <div class="actions">
          ${actionMarkup}
        </div>
        <div class="meta">
          <div>
            <p class="meta-label">Environment</p>
            <strong>${escapeHtml(new URL(c.req.url).host)}</strong>
          </div>
          <div>
            <p class="meta-label">Request ID</p>
            <strong>${requestId}</strong>
          </div>
        </div>
        <div class="pulse"></div>
      </section>
    </main>
  </body>
</html>`
  const response = new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
    },
  })

  return withPrivateResponseHeaders(response)
}

function withPrivateResponseHeaders(response: Response) {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')

  return response
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
