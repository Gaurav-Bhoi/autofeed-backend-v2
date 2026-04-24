import { serviceUnavailable } from '../../../shared/http/errors'
import { type LinkedInAuthConfig } from '../domain/linkedin.entities'

export function getLinkedInAuthConfig(env: Env): LinkedInAuthConfig {
  const clientId = env.LINKEDIN_CLIENT_ID?.trim()
  const clientSecret = env.LINKEDIN_CLIENT_SECRET?.trim()
  const redirectUri = parseAbsoluteUrl(
    env.LINKEDIN_REDIRECT_URI?.trim(),
    'LINKEDIN_REDIRECT_URI',
  )

  if (!clientId) {
    throw serviceUnavailable('Missing LINKEDIN_CLIENT_ID environment variable')
  }

  return {
    clientId,
    redirectUri,
    ...(clientSecret
      ? {
          clientSecret,
        }
      : {}),
  }
}

function parseAbsoluteUrl(value: string | undefined, variableName: string) {
  if (!value) {
    throw serviceUnavailable(`Missing ${variableName} environment variable`)
  }

  try {
    return new URL(value).toString()
  } catch {
    throw serviceUnavailable(
      `${variableName} must be a valid absolute URL`,
    )
  }
}
