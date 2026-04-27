import { badRequest } from '../../../../shared/http/errors'

import { initWasm, Resvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm?module'

import notoSansBold from '../../../../assets/fonts/NotoSans-Bold.bin'
import notoSansRegular from '../../../../assets/fonts/NotoSans-Regular.bin'

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1080
const IMAGE_AREA_HEIGHT = 715
const PANEL_Y = 670
const TEXT_LEFT = 58
const TEXT_MAX_WIDTH = CARD_WIDTH - TEXT_LEFT * 2
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024
const NEWS_CARD_VERSION = '3'
const DEFAULT_SOURCE_LABEL = 'AutoFeed News'
const CARD_THEMES = [
  {
    accent: '#facc15',
    accent2: '#22c55e',
    fallbackA: '#111827',
    fallbackB: '#0f766e',
  },
  {
    accent: '#fb923c',
    accent2: '#a3e635',
    fallbackA: '#18181b',
    fallbackB: '#7c2d12',
  },
  {
    accent: '#fde047',
    accent2: '#38bdf8',
    fallbackA: '#0f172a',
    fallbackB: '#1d4ed8',
  },
  {
    accent: '#f97316',
    accent2: '#fef08a',
    fallbackA: '#111827',
    fallbackB: '#7f1d1d',
  },
] as const
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'amid',
  'and',
  'are',
  'around',
  'from',
  'has',
  'have',
  'into',
  'its',
  'more',
  'new',
  'over',
  'says',
  'that',
  'the',
  'their',
  'this',
  'with',
])
const FONT_BUFFERS = [
  new Uint8Array(notoSansRegular),
  new Uint8Array(notoSansBold),
]
const defaultFetcher: typeof fetch = (input, init) => fetch(input, init)

let initPromise: Promise<void> | null = null

export type LinkedInNewsCardImageInput = {
  title: string
  summary?: string
  sourceLabel?: string
  sourceImageUrl?: string
  requireSourceImage?: boolean
  theme?: string
}

export function createLinkedInNewsCardImageUrl(
  publicBaseUrl: string,
  input: LinkedInNewsCardImageInput,
) {
  const url = new URL('/api/content/linkedin/news-card.png', publicBaseUrl)

  url.searchParams.set('v', NEWS_CARD_VERSION)
  url.searchParams.set('title', truncateText(input.title, 220))

  if (input.summary?.trim()) {
    url.searchParams.set('summary', truncateText(input.summary.trim(), 180))
  }

  if (input.sourceLabel?.trim()) {
    url.searchParams.set('source', truncateText(input.sourceLabel.trim(), 80))
  }

  if (input.sourceImageUrl?.trim()) {
    url.searchParams.set('image', input.sourceImageUrl.trim())
  }

  if (input.requireSourceImage) {
    url.searchParams.set('requireImage', '1')
  }

  if (input.theme?.trim()) {
    url.searchParams.set('theme', input.theme.trim())
  }

  return url.toString()
}

export function readLinkedInNewsCardImageInputFromUrl(
  url: URL,
): LinkedInNewsCardImageInput {
  const title = url.searchParams.get('title')?.trim()

  if (!title) {
    throw badRequest('title is required')
  }

  const input: LinkedInNewsCardImageInput = {
    title: truncateText(title, 240),
  }
  const summary = url.searchParams.get('summary')?.trim()
  const sourceLabel = url.searchParams.get('source')?.trim()
  const sourceImageUrl =
    url.searchParams.get('image')?.trim() ?? url.searchParams.get('img')?.trim()
  const requireSourceImage =
    url.searchParams.get('requireImage') === '1' ||
    url.searchParams.get('requireImage')?.toLowerCase() === 'true'
  const theme = url.searchParams.get('theme')?.trim()

  if (summary) {
    input.summary = truncateText(summary, 220)
  }

  if (sourceLabel) {
    input.sourceLabel = truncateText(sourceLabel, 90)
  }

  if (sourceImageUrl) {
    input.sourceImageUrl = cleanHttpUrl(sourceImageUrl, 'image')
  }

  if (requireSourceImage) {
    input.requireSourceImage = true
  }

  if (theme) {
    input.theme = theme
  }

  return input
}

export async function renderLinkedInNewsCardImage(
  input: LinkedInNewsCardImageInput,
  fetcher: typeof fetch = defaultFetcher,
) {
  await ensureResvgInitialized()

  const sourceImageBytes = await fetchSourceImage(input.sourceImageUrl, fetcher)

  if (input.requireSourceImage && !sourceImageBytes) {
    throw badRequest('news card source image could not be fetched')
  }

  return renderNewsCardPng(input, sourceImageBytes)
}

async function ensureResvgInitialized() {
  initPromise ??= initWasm(resvgWasm)

  return initPromise
}

async function fetchSourceImage(
  sourceImageUrl: string | undefined,
  fetcher: typeof fetch,
) {
  if (!sourceImageUrl) {
    return null
  }

  try {
    const response = await fetcher(sourceImageUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'autofeed-news-card/1.0',
      },
    })

    if (!response.ok) {
      return null
    }

    const contentLength = Number.parseInt(
      response.headers.get('content-length') ?? '',
      10,
    )

    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_IMAGE_BYTES) {
      return null
    }

    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''

    if (contentType && !contentType.startsWith('image/')) {
      return null
    }

    const bytes = new Uint8Array(await response.arrayBuffer())

    return bytes.byteLength <= MAX_SOURCE_IMAGE_BYTES ? bytes : null
  } catch {
    return null
  }
}

function renderNewsCardPng(
  input: LinkedInNewsCardImageInput,
  sourceImageBytes: Uint8Array | null,
) {
  const withImageSvg = createNewsCardSvg(input, Boolean(sourceImageBytes))

  if (!sourceImageBytes) {
    return renderSvgToPng(withImageSvg)
  }

  try {
    return renderSvgToPng(withImageSvg, sourceImageBytes, input.sourceImageUrl)
  } catch {
    return renderSvgToPng(createNewsCardSvg(input, false))
  }
}

function renderSvgToPng(
  svg: string,
  sourceImageBytes?: Uint8Array,
  sourceImageHref?: string,
) {
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontBuffers: FONT_BUFFERS,
      defaultFontFamily: 'Noto Sans',
      sansSerifFamily: 'Noto Sans',
    },
    imageRendering: 0,
    textRendering: 1,
  })

  if (sourceImageBytes && sourceImageHref) {
    resvg.resolveImage(sourceImageHref, sourceImageBytes)
  }

  const rendered = resvg.render()
  const png = rendered.asPng()

  rendered.free()
  resvg.free()

  return png
}

function createNewsCardSvg(
  input: LinkedInNewsCardImageInput,
  includeSourceImage: boolean,
) {
  const title = normalizeCardText(input.title)
  const summary =
    normalizeCardText(input.summary ?? '') ||
    'A developing story worth tracking beyond the headline.'
  const sourceLabel =
    normalizeCardText(input.sourceLabel ?? '') || DEFAULT_SOURCE_LABEL
  const theme = pickTheme(input.theme ?? title)
  const headlineFontSize = chooseHeadlineFontSize(title)
  const headlineHighlights = createHeadlineHighlights(title)
  const headline = buildTextBlock({
    text: title,
    x: TEXT_LEFT,
    y: 770,
    maxWidth: TEXT_MAX_WIDTH,
    fontSize: headlineFontSize,
    lineHeight: Math.round(headlineFontSize * 1.15),
    maxLines: headlineFontSize <= 44 ? 5 : 4,
    fontWeight: 900,
    defaultColor: '#ffffff',
    highlightColor: theme.accent,
    highlights: headlineHighlights,
  })
  const summaryStartY = Math.min(headline.nextY + 24, 1010)
  const summaryLineCount = summaryStartY <= 930 ? 2 : summaryStartY <= 970 ? 1 : 0
  const summaryBlock =
    summaryLineCount > 0
      ? buildTextBlock({
          text: summary,
          x: TEXT_LEFT,
          y: summaryStartY,
          maxWidth: TEXT_MAX_WIDTH,
          fontSize: 31,
          lineHeight: 39,
          maxLines: summaryLineCount,
          fontWeight: 500,
          defaultColor: '#f7f7f7',
          highlightColor: theme.accent2,
          highlights: createSummaryHighlights(summary),
        }).markup
      : ''
  const sourceText = truncateText(sourceLabel, 62).toUpperCase()
  const sourceWidth = Math.min(410, Math.max(190, sourceText.length * 15 + 52))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="fallbackBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${theme.fallbackA}"/>
      <stop offset="1" stop-color="${theme.fallbackB}"/>
    </linearGradient>
    <linearGradient id="imageFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.52" stop-color="#000000" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#000000" stop-opacity="1"/>
    </linearGradient>
    <radialGradient id="spotlight" cx="0.78" cy="0.18" r="0.82">
      <stop offset="0" stop-color="${theme.accent}" stop-opacity="0.46"/>
      <stop offset="0.55" stop-color="${theme.fallbackB}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="9" stdDeviation="14" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <clipPath id="imageClip">
      <rect x="0" y="0" width="${CARD_WIDTH}" height="${IMAGE_AREA_HEIGHT}"/>
    </clipPath>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#050505"/>
  ${
    includeSourceImage
      ? `<image href="${xmlEscape(input.sourceImageUrl ?? '')}" x="0" y="0" width="${CARD_WIDTH}" height="${IMAGE_AREA_HEIGHT}" preserveAspectRatio="xMidYMid slice" clip-path="url(#imageClip)"/>`
      : `<rect x="0" y="0" width="${CARD_WIDTH}" height="${IMAGE_AREA_HEIGHT}" fill="url(#fallbackBg)"/>
  <circle cx="860" cy="170" r="270" fill="url(#spotlight)"/>
  <circle cx="196" cy="390" r="210" fill="${theme.accent2}" opacity="0.16"/>
  <path d="M88 474 C252 300 438 628 628 390 C760 226 906 240 1008 118" fill="none" stroke="${theme.accent}" stroke-width="11" opacity="0.46"/>`
  }
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${IMAGE_AREA_HEIGHT}" fill="#000000" opacity="0.14"/>
  <rect x="0" y="${PANEL_Y - 210}" width="${CARD_WIDTH}" height="250" fill="url(#imageFade)"/>
  <rect x="0" y="${PANEL_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT - PANEL_Y}" fill="#050505"/>
  <rect x="${TEXT_LEFT}" y="46" width="${sourceWidth}" height="58" rx="12" fill="#050505" opacity="0.88" filter="url(#softShadow)"/>
  <text x="${TEXT_LEFT + 25}" y="84" font-family="Noto Sans" font-size="24" font-weight="900" fill="#ffffff" letter-spacing="1.5">${xmlEscape(sourceText)}</text>
  <rect x="${TEXT_LEFT}" y="${PANEL_Y - 30}" width="164" height="7" rx="3.5" fill="${theme.accent}"/>
  ${headline.markup}
  ${summaryBlock}
  <text x="${TEXT_LEFT}" y="1040" font-family="Noto Sans" font-size="23" font-weight="800" fill="${theme.accent}" letter-spacing="1.8">AUTOFEED NEWS</text>
  <text x="${CARD_WIDTH - TEXT_LEFT}" y="1040" font-family="Noto Sans" font-size="23" font-weight="800" fill="#ffffff" text-anchor="end" opacity="0.78">LINKEDIN EDITION</text>
</svg>`
}

function buildTextBlock(input: {
  text: string
  x: number
  y: number
  maxWidth: number
  fontSize: number
  lineHeight: number
  maxLines: number
  fontWeight: number
  defaultColor: string
  highlightColor: string
  highlights: Set<string>
}) {
  const lines = wrapText(input.text, input.maxWidth, input.fontSize, input.maxLines)
  const lineMarkup = lines
    .map((line, index) => {
      const words = line.split(/\s+/).filter(Boolean)
      const tspans = words
        .map((word, wordIndex) => {
          const key = cleanWord(word)
          const color =
            input.highlights.has(key) || looksLikeNumber(word)
              ? input.highlightColor
              : input.defaultColor
          const suffix = wordIndex < words.length - 1 ? ' ' : ''

          return `<tspan fill="${color}">${xmlEscape(word + suffix)}</tspan>`
        })
        .join('')

      return `<text xml:space="preserve" x="${input.x}" y="${
        input.y + index * input.lineHeight
      }" font-family="Noto Sans" font-size="${input.fontSize}" font-weight="${
        input.fontWeight
      }">${tspans}</text>`
    })
    .join('\n')

  return {
    markup: lineMarkup,
    nextY: input.y + Math.max(lines.length, 1) * input.lineHeight,
  }
}

function wrapText(
  value: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
) {
  const words = value.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let currentLine = ''
  let currentWidth = 0

  for (const word of words) {
    const wordWidth = estimateWordWidth(word, fontSize)
    const spaceWidth = currentLine ? fontSize * 0.34 : 0

    if (currentLine && currentWidth + spaceWidth + wordWidth > maxWidth) {
      lines.push(currentLine)
      currentLine = word
      currentWidth = wordWidth
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word
      currentWidth += spaceWidth + wordWidth
    }

    if (lines.length === maxLines) {
      break
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine)
  }

  if (lines.length === 0) {
    return ['News update']
  }

  const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length

  if (usedWords < words.length) {
    const lastIndex = lines.length - 1
    const line = lines[lastIndex] ?? ''

    lines[lastIndex] = trimLineToWidth(line, maxWidth, fontSize)
  }

  return lines
}

function trimLineToWidth(line: string, maxWidth: number, fontSize: number) {
  const ellipsis = '...'
  let next = line

  while (
    next.length > 8 &&
    estimateLineWidth(`${next}${ellipsis}`, fontSize) > maxWidth
  ) {
    next = next.replace(/\s+\S+$/, '')
  }

  return `${next.replace(/[.,:;!?-]+$/, '')}${ellipsis}`
}

function estimateLineWidth(value: string, fontSize: number) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .reduce(
      (width, word, index) =>
        width + estimateWordWidth(word, fontSize) + (index === 0 ? 0 : fontSize * 0.34),
      0,
    )
}

function estimateWordWidth(word: string, fontSize: number) {
  let units = 0

  for (const char of word) {
    if (/[A-Z0-9]/.test(char)) {
      units += 0.64
    } else if (/[ilI.,'|]/.test(char)) {
      units += 0.31
    } else if (/[-:;!?]/.test(char)) {
      units += 0.36
    } else {
      units += 0.56
    }
  }

  return units * fontSize
}

function createHeadlineHighlights(title: string) {
  const scored = title
    .split(/\s+/)
    .map((word, index) => ({
      word: cleanWord(word),
      score: scoreHighlightWord(word, index),
    }))
    .filter((item) => item.word.length > 2 && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)

  return new Set(scored.map((item) => item.word))
}

function createSummaryHighlights(summary: string) {
  return new Set(
    summary
      .split(/\s+/)
      .map(cleanWord)
      .filter((word) => word.length > 7)
      .slice(0, 4),
  )
}

function scoreHighlightWord(word: string, index: number) {
  const cleaned = cleanWord(word)

  if (!cleaned || STOP_WORDS.has(cleaned)) {
    return 0
  }

  let score = Math.min(cleaned.length, 12)

  if (looksLikeNumber(word)) {
    score += 18
  }

  if (/^[A-Z]/.test(word)) {
    score += 7
  }

  if (index < 8) {
    score += 5
  }

  return score
}

function chooseHeadlineFontSize(title: string) {
  if (title.length > 175) {
    return 40
  }

  if (title.length > 135) {
    return 44
  }

  if (title.length > 92) {
    return 50
  }

  return 58
}

function pickTheme(seed: string) {
  const index = hashString(seed) % CARD_THEMES.length

  return CARD_THEMES[index] ?? CARD_THEMES[0]
}

function normalizeCardText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanHttpUrl(value: string, fieldName: string) {
  try {
    const url = new URL(value)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }

    return url.toString()
  } catch {
    throw badRequest(`${fieldName} must be a valid HTTP or HTTPS URL`)
  }
}

function cleanWord(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function looksLikeNumber(value: string) {
  return /(?:\d|[$%])/.test(value)
}

function hashString(value: string) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return value.slice(0, maxLength - 3).trimEnd() + '...'
}
