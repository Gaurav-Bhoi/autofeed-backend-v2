const ENCRYPTED_SECRET_PREFIX = 'enc:v1:'

export async function protectSecret(
  secret: string,
  value: string | null,
): Promise<string | null> {
  if (value === null || value.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return value
  }

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(secret)
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    new TextEncoder().encode(value),
  )

  return `${ENCRYPTED_SECRET_PREFIX}${toBase64Url(iv)}.${toBase64Url(
    new Uint8Array(ciphertext),
  )}`
}

export async function revealSecret(secret: string, value: string) {
  if (!value.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return value
  }

  const encrypted = value.slice(ENCRYPTED_SECRET_PREFIX.length)
  const [encodedIv, encodedCiphertext] = encrypted.split('.')

  if (!encodedIv || !encodedCiphertext) {
    return value
  }

  const key = await deriveAesKey(secret)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(encodedIv),
    },
    key,
    fromBase64Url(encodedCiphertext),
  )

  return new TextDecoder().decode(plaintext)
}

async function deriveAesKey(secret: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`autofeed:linkedin-token:${secret}`),
  )

  return crypto.subtle.importKey(
    'raw',
    digest,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
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
