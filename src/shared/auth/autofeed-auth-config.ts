import { serviceUnavailable } from '../http/errors'

type AutofeedAuthEnv = Env & {
  AUTOFEED_SESSION_SECRET?: string
  AUTOFEED_SESSION_TTL_SECONDS?: string
  LINKEDIN_OAUTH_STATE_TTL_SECONDS?: string
}

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_OAUTH_STATE_TTL_SECONDS = 10 * 60

export function readAutofeedSigningSecret(env: Env) {
  const authEnv = env as AutofeedAuthEnv
  const secret =
    authEnv.AUTOFEED_SESSION_SECRET?.trim() ||
    authEnv.LINKEDIN_CLIENT_SECRET?.trim()

  if (!secret) {
    throw serviceUnavailable(
      'Missing AUTOFEED_SESSION_SECRET environment variable',
    )
  }

  return secret
}

export function readAutofeedSessionTtlSeconds(env: Env) {
  return readPositiveInteger(
    (env as AutofeedAuthEnv).AUTOFEED_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
  )
}

export function readLinkedInOAuthStateTtlSeconds(env: Env) {
  return readPositiveInteger(
    (env as AutofeedAuthEnv).LINKEDIN_OAUTH_STATE_TTL_SECONDS,
    DEFAULT_OAUTH_STATE_TTL_SECONDS,
  )
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}
