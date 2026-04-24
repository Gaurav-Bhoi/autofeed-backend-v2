import { badRequest, unauthorized } from './errors'

export async function parseJsonObject<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  let payload: unknown

  try {
    payload = await request.json()
  } catch {
    throw badRequest('Request body must be valid JSON')
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('Request body must be a JSON object')
  }

  return payload as T
}

export function getBearerToken(authorizationHeader?: string | null) {
  if (!authorizationHeader) {
    throw unauthorized('Missing Authorization header')
  }

  const [scheme, ...rawTokenParts] = authorizationHeader.trim().split(/\s+/)

  if (scheme !== 'Bearer' || rawTokenParts.length === 0) {
    throw unauthorized('Authorization header must use the Bearer scheme')
  }

  const token = rawTokenParts.join(' ').trim()

  if (!token) {
    throw unauthorized('Authorization header is missing the bearer token')
  }

  return token
}
