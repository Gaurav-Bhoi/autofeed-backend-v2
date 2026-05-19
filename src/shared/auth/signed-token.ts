import { unauthorized } from '../http/errors'

export type SignedTokenPayload = Record<string, unknown> & {
  iat: number
  exp: number
}

export async function createSignedToken(input: {
  prefix: string
  secret: string
  payload: Record<string, unknown>
  ttlSeconds: number
  now?: Date
}) {
  const now = input.now ?? new Date()
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresAt = issuedAt + input.ttlSeconds
  const payload = removeUndefinedValues({
    ...input.payload,
    iat: issuedAt,
    exp: expiresAt,
  })
  const body = toBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  const signature = await sign(input.secret, `${input.prefix}${body}`)

  return {
    token: `${input.prefix}${body}.${signature}`,
    expiresAt,
  }
}

export async function verifySignedToken<TPayload extends SignedTokenPayload>(
  input: {
    token: string
    prefix: string
    secret: string
    now?: Date
  },
): Promise<TPayload> {
  const token = input.token.trim()

  if (!token.startsWith(input.prefix)) {
    throw unauthorized('Invalid session token')
  }

  const separatorIndex = token.lastIndexOf('.')

  if (separatorIndex <= input.prefix.length) {
    throw unauthorized('Invalid session token')
  }

  const unsigned = token.slice(0, separatorIndex)
  const signature = token.slice(separatorIndex + 1)

  if (!unsigned || !signature || !unsigned.startsWith(input.prefix)) {
    throw unauthorized('Invalid session token')
  }

  const expected = await sign(input.secret, unsigned)

  if (!timingSafeEqual(signature, expected)) {
    throw unauthorized('Invalid session token')
  }

  const encodedPayload = unsigned.slice(input.prefix.length)
  const payload = JSON.parse(
    new TextDecoder().decode(fromBase64Url(encodedPayload)),
  ) as Partial<TPayload>
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000)

  if (
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now
  ) {
    throw unauthorized('Session token expired')
  }

  return payload as TPayload
}

export async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return toBase64Url(new Uint8Array(digest))
}

export async function hmacBase64Url(secret: string, value: string) {
  return sign(secret, value)
}

function removeUndefinedValues(input: Record<string, unknown>) {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value
    }
  }

  return result
}

async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )

  return toBase64Url(new Uint8Array(signature))
}

function toBase64Url(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(input: string) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '=',
  )
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function timingSafeEqual(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length)
  let diff = left.length === right.length ? 0 : 1

  for (let i = 0; i < maxLength; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  }

  return diff === 0
}
