import { badGateway, serviceUnavailable } from '../../../../shared/http/errors'
import type { LinkedInContentPublishInput } from './publish-linkedin-content.service'

const DEFAULT_RUNPOD_ENDPOINT_ID = 'qexf1iafzz41nh'
const DEFAULT_RUNPOD_MODEL = 'Qwen2.5-VL-32B-Instruct'
const DEFAULT_MAX_NEW_TOKENS = 650
const DEFAULT_TEMPERATURE = 0.2
const DEFAULT_POLL_TIMEOUT_MS = 45_000
const DEFAULT_POLL_INTERVAL_MS = 5_000
const RUNPOD_IMAGE_INPUT_MODES = [
  'image-url',
  'text-url',
  'base64-image-url',
] as const
const defaultFetcher: typeof fetch = (input, init) => fetch(input, init)
const terminalRunPodStatuses = new Set([
  'COMPLETED',
  'FAILED',
  'ERROR',
  'CANCELLED',
  'CANCELED',
  'TIMED_OUT',
])

export type RunPodLinkedInContentConfig = {
  endpointId: string
  apiKey: string
  model: string
  maxNewTokens: number
  temperature: number
  pollTimeoutMs: number
  pollIntervalMs: number
}

export type RunPodJobResult = {
  id: string
  status: string
  output: unknown
  error: string | null
}

export type RunPodLinkedInPostContent = {
  caption: string
  postContent: string
  hashtags: string[]
}

export type RunPodImageInputMode = (typeof RUNPOD_IMAGE_INPUT_MODES)[number]

type RunPodApiResponse = {
  id?: string
  status?: string
  output?: unknown
  error?: unknown
  errorMessage?: unknown
  message?: unknown
}

type RunPodEnv = Env & {
  RUNPOD_API_KEY?: string
  CONTENT_LINKEDIN_RUNPOD_ENDPOINT_ID?: string
  CONTENT_LINKEDIN_RUNPOD_MODEL?: string
  CONTENT_LINKEDIN_RUNPOD_MAX_NEW_TOKENS?: string
  CONTENT_LINKEDIN_RUNPOD_TEMPERATURE?: string
  CONTENT_LINKEDIN_RUNPOD_POLL_TIMEOUT_MS?: string
  CONTENT_LINKEDIN_RUNPOD_POLL_INTERVAL_MS?: string
}

export class RunPodLinkedInContentService {
  constructor(
    private readonly config: RunPodLinkedInContentConfig,
    private readonly fetcher: typeof fetch = defaultFetcher,
  ) {}

  async submit(input: {
    imageUrl: string
    section: string
    sourceUrl?: string | null
    contentInput: LinkedInContentPublishInput
    imageInputMode: RunPodImageInputMode
  }): Promise<RunPodJobResult> {
    const messages = await createRunPodMessages(input, this.fetcher)
    const response = await this.fetcher(this.buildUrl('run'), {
      method: 'POST',
      headers: this.createHeaders(),
      body: JSON.stringify({
        input: {
          task: 'chat',
          model: this.config.model,
          max_new_tokens: this.config.maxNewTokens,
          temperature: this.config.temperature,
          messages,
        },
      }),
    })

    return this.readJobResponse(response, 'RunPod job submission failed')
  }

  async waitForResult(jobId: string): Promise<RunPodJobResult> {
    const startedAt = Date.now()
    let latest: RunPodJobResult | null = null

    do {
      latest = await this.getStatus(jobId)

      if (terminalRunPodStatuses.has(latest.status.toUpperCase())) {
        return latest
      }

      await sleep(this.config.pollIntervalMs)
    } while (Date.now() - startedAt < this.config.pollTimeoutMs)

    return latest
  }

  parsePostContent(output: unknown): RunPodLinkedInPostContent {
    const payload = findJsonObject(output)

    if (!payload) {
      throw badGateway('RunPod output did not include a valid JSON object')
    }

    const caption = readString(payload, 'caption')
    const rawPostContent =
      readString(payload, 'post_content') ?? readString(payload, 'postContent')
    const hashtags = readHashtags(payload.hashtags)
    const postContent = rawPostContent
      ? sanitizeGeneratedPostContent(rawPostContent)
      : null

    if (!caption || !postContent || hashtags.length === 0) {
      throw badGateway(
        'RunPod output must include caption, post_content, and hashtags',
      )
    }

    return {
      caption: truncateText(sanitizeGeneratedCaption(caption), 240),
      postContent: truncateText(postContent, 2200),
      hashtags,
    }
  }

  private async getStatus(jobId: string): Promise<RunPodJobResult> {
    const response = await this.fetcher(this.buildUrl(`status/${jobId}`), {
      headers: {
        Authorization: formatAuthorization(this.config.apiKey),
      },
    })

    return this.readJobResponse(response, 'RunPod status request failed')
  }

  private async readJobResponse(response: Response, fallback: string) {
    const payload = (await readJson(response)) as RunPodApiResponse | null

    if (!response.ok) {
      throw badGateway(readRunPodError(payload) ?? fallback)
    }

    if (!payload?.id) {
      throw badGateway('RunPod response did not include a job id')
    }

    return {
      id: payload.id,
      status: payload.status ?? 'UNKNOWN',
      output: payload.output,
      error: readRunPodError(payload),
    }
  }

  private buildUrl(path: string) {
    return `https://api.runpod.ai/v2/${this.config.endpointId}/${path}`
  }

  private createHeaders() {
    return {
      Authorization: formatAuthorization(this.config.apiKey),
      'Content-Type': 'application/json',
    }
  }
}

export function readRunPodImageInputMode(
  value: string | null | undefined,
): RunPodImageInputMode {
  const mode = value?.trim()

  return isRunPodImageInputMode(mode) ? mode : 'image-url'
}

export function getNextRunPodImageInputMode(
  value: string | null | undefined,
): RunPodImageInputMode | null {
  const mode = readRunPodImageInputMode(value)
  const index = RUNPOD_IMAGE_INPUT_MODES.indexOf(mode)

  return RUNPOD_IMAGE_INPUT_MODES[index + 1] ?? null
}

export function readRunPodLinkedInContentConfig(
  env: Env,
): RunPodLinkedInContentConfig {
  const runPodEnv = env as RunPodEnv
  const apiKey = runPodEnv.RUNPOD_API_KEY?.trim()

  if (!apiKey) {
    throw serviceUnavailable('Missing RUNPOD_API_KEY secret')
  }

  return {
    endpointId:
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_ENDPOINT_ID?.trim() ??
      DEFAULT_RUNPOD_ENDPOINT_ID,
    apiKey,
    model:
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_MODEL?.trim() ?? DEFAULT_RUNPOD_MODEL,
    maxNewTokens: readPositiveInteger(
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_MAX_NEW_TOKENS,
      DEFAULT_MAX_NEW_TOKENS,
    ),
    temperature: readNumber(
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_TEMPERATURE,
      DEFAULT_TEMPERATURE,
    ),
    pollTimeoutMs: readPositiveInteger(
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_POLL_TIMEOUT_MS,
      DEFAULT_POLL_TIMEOUT_MS,
    ),
    pollIntervalMs: readPositiveInteger(
      runPodEnv.CONTENT_LINKEDIN_RUNPOD_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
  }
}

export function composeLinkedInText(input: RunPodLinkedInPostContent) {
  const hashtags = input.hashtags.map(formatHashtag).filter(Boolean)
  const text = [input.postContent, input.caption, hashtags.join(' ')]
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n')

  return truncateText(text, 3000)
}

async function createRunPodMessages(
  input: {
    imageUrl: string
    section: string
    sourceUrl?: string | null
    contentInput: LinkedInContentPublishInput
    imageInputMode: RunPodImageInputMode
  },
  fetcher: typeof fetch,
) {
  const context = [
    `Section: ${input.section}`,
    `Topic: ${input.contentInput.topic}`,
    input.contentInput.objective
      ? `Objective: ${input.contentInput.objective}`
      : '',
    input.sourceUrl ? `Source URL: ${input.sourceUrl}` : '',
    `Image URL: ${input.imageUrl}`,
  ]
    .filter(Boolean)
    .join('\n')
  const systemPrompt =
    'You are an expert LinkedIn content creator for tech memes and broad news stories, including business, politics, geopolitics, regional affairs, science, and technology. Read the image and context carefully. For news, do not invent facts beyond the title, image, and source context. Output only one valid compact JSON object, with no markdown fence and no text outside JSON. Required keys: caption, post_content, hashtags. caption must be one short sentence. post_content must be 120 to 180 words, plain text, no markdown, no headings, no numbered list, no hashtags, and no emoji. hashtags must be an array of 4 to 6 relevant hashtag strings.'

  if (input.imageInputMode === 'text-url') {
    return [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: `Create a LinkedIn post from this image URL.\n\n${context}`,
      },
    ]
  }

  const imageUrl =
    input.imageInputMode === 'base64-image-url'
      ? await createImageDataUrl(input.imageUrl, fetcher)
      : input.imageUrl

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Create a LinkedIn post from this image.\n\n${context}`,
        },
        {
          type: 'image_url',
          image_url: {
            url: imageUrl,
          },
        },
      ],
    },
  ]
}

async function createImageDataUrl(imageUrl: string, fetcher: typeof fetch) {
  const response = await fetcher(imageUrl)

  if (!response.ok) {
    throw badGateway('Failed to fetch image for RunPod base64 input')
  }

  const contentType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  const bytes = new Uint8Array(await response.arrayBuffer())

  return `data:${contentType};base64,${base64Encode(bytes)}`
}

function base64Encode(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function isRunPodImageInputMode(
  value: string | undefined,
): value is RunPodImageInputMode {
  return RUNPOD_IMAGE_INPUT_MODES.includes(value as RunPodImageInputMode)
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return {
      message: text,
    }
  }
}

function findJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    return parseJsonObjectFromText(value)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonObject(item)

      if (found) {
        return found
      }
    }

    return null
  }

  if (typeof value !== 'object') {
    return null
  }

  if (
    'caption' in value ||
    'post_content' in value ||
    'postContent' in value ||
    'hashtags' in value
  ) {
    return value as Record<string, unknown>
  }

  for (const key of ['content', 'text', 'response', 'generated_text', 'message']) {
    if (key in value) {
      const found = findJsonObject((value as Record<string, unknown>)[key])

      if (found) {
        return found
      }
    }
  }

  if ('choices' in value) {
    return findJsonObject((value as Record<string, unknown>).choices)
  }

  return null
}

function parseJsonObjectFromText(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')

  try {
    const parsed = JSON.parse(cleaned) as unknown

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null
    }

    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as unknown

      return typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key]

  return typeof field === 'string' && field.trim() ? field.trim() : null
}

function readHashtags(value: unknown) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []

  return [
    ...new Set(
      rawValues
        .filter((item): item is string => typeof item === 'string')
        .map(formatHashtag)
        .filter(Boolean),
    ),
  ].slice(0, 8)
}

function sanitizeGeneratedPostContent(value: string) {
  return removeTrailingHashtags(sanitizeGeneratedText(value))
}

function sanitizeGeneratedCaption(value: string) {
  return removeTrailingHashtags(sanitizeGeneratedText(value))
}

function sanitizeGeneratedText(value: string) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim()
}

function removeTrailingHashtags(value: string) {
  const lines = value.trim().split('\n')

  while (lines.length > 0) {
    const line = lines[lines.length - 1]?.trim() ?? ''

    if (!line) {
      lines.pop()
      continue
    }

    if (isHashtagOnlyLine(line)) {
      lines.pop()
      continue
    }

    const withoutTrailingTags = line
      .split(/\s+/)
      .filter(Boolean)
      .reduceRight(
        (state, token) => {
          if (state.removing && isHashtagToken(token)) {
            return state
          }

          state.removing = false
          state.tokens.unshift(token)
          return state
        },
        { removing: true, tokens: [] as string[] },
      ).tokens
      .join(' ')

    lines[lines.length - 1] = withoutTrailingTags || line
    break
  }

  return lines.join('\n').trim()
}

function isHashtagOnlyLine(value: string) {
  const tokens = value.split(/\s+/).filter(Boolean)

  return tokens.length > 0 && tokens.every(isHashtagToken)
}

function isHashtagToken(value: string) {
  return /^#[a-z0-9_]+[,.!?;:]*$/i.test(value)
}

function formatHashtag(value: string) {
  const cleaned = value.replace(/^#/, '').replace(/[^a-z0-9_]/gi, '')

  return cleaned ? `#${cleaned}` : ''
}

function formatAuthorization(apiKey: string) {
  return apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`
}

function readRunPodError(payload: RunPodApiResponse | null) {
  if (!payload) {
    return null
  }

  for (const key of ['error', 'errorMessage', 'message'] as const) {
    const value = payload[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? '')

  return Number.isFinite(parsed) ? parsed : fallback
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return value.slice(0, maxLength - 3).trimEnd() + '...'
}

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}
