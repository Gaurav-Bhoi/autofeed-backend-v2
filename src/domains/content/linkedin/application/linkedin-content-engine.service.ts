import { serviceUnavailable } from '../../../../shared/http/errors'
import { XMLParser } from 'fast-xml-parser'
import {
  LINKEDIN_VISIBILITY_VALUES,
  type LinkedInVisibility,
} from '../../../linkedin/domain/linkedin.entities'
import type { LinkedInContentHistoryRepository } from '../domain/linkedin-content-history.repository'
import {
  LINKEDIN_CONTENT_TONES,
  type LinkedInContentTone,
} from '../domain/linkedin-content.entity'
import { createLinkedInNewsCardImageUrl } from './linkedin-news-card-image.service'
import type { LinkedInContentPublishInput } from './publish-linkedin-content.service'

const TECH_MEMES_SECTION = 'tech-memes'
const NEWS_SECTION = 'news'
const LEGACY_TECH_NEWS_SECTION = 'tech-news'
const REDDIT_POST_LIMIT = 20
const DEFAULT_REDDIT_USER_AGENT =
  'script:linkedin-news:v1.0 (by /u/YOUR_REDDIT_USERNAME)'
const rssParser = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false,
  trimValues: true,
})
const MEMEGEN_TEMPLATES = [
  'afraid',
  'badchoice',
  'bihw',
  'blb',
  'boat',
  'both',
  'bus',
  'buzz',
  'captain',
  'cbg',
  'cheems',
  'ds',
  'spongebob',
  'stop-it',
  'success',
  'touch',
  'woman-cat',
  'wonka',
  'yallgot',
  'yuno',
] as const
const DEFAULT_MEME_SUBREDDITS = [
  'ProgrammerHumor',
  'programmingmemes',
  'softwaregore',
  'iiiiiiitttttttttttt',
  'linuxmemes',
  'webdevmemes',
] as const
const DEFAULT_REDDIT_SUBREDDITS = [
  'worldnews',
  'news',
  'geopolitics',
  'india',
  'IndianPolitics',
  'IndianModerate',
  'unitedstatesofindia',
  'business',
  'economics',
  'technology',
  'science',
  'UpliftingNews',
] as const
const DEFAULT_NEWS_RSS_FEEDS = [
  {
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    sourceLabel: 'BBC World',
  },
  {
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    sourceLabel: 'BBC Business',
  },
  {
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    sourceLabel: 'BBC Technology',
  },
  {
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    sourceLabel: 'BBC Science',
  },
  {
    url: 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en',
    sourceLabel: 'Google News India',
  },
  {
    url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-IN&gl=IN&ceid=IN:en',
    sourceLabel: 'Google News World',
  },
  {
    url: 'https://news.google.com/rss/headlines/section/topic/NATION?hl=en-IN&gl=IN&ceid=IN:en',
    sourceLabel: 'Google News India',
  },
  {
    url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en',
    sourceLabel: 'Google News Business',
  },
] as const
const defaultFetcher: typeof fetch = (input, init) => fetch(input, init)
const memeTopLines = [
  'Deploying on Friday',
  'Skipping tests',
  'Pushing straight to main',
  'It works on my machine',
  'Changing one CSS line',
  'Ignoring the flaky test',
  'Upgrading dependencies',
  'Hotfix before lunch',
  'Renaming the env var',
  'Turning logs off',
]
const memeBottomLines = [
  'What could go wrong',
  'CI would like a word',
  'Rollback has entered the chat',
  'Production noticed',
  'The pager is awake',
  'Users found the edge case',
  'The build said absolutely not',
  'Observability became important',
  'Cache invalidation joined the call',
  'Now it is a platform problem',
]

export type LinkedInContentPoolItem = LinkedInContentPublishInput & {
  section: string
  id?: string
  sourceUrl?: string
}

export type LinkedInContentSelection = {
  contentKey: string
  section: string
  itemId: string | null
  sourceUrl: string | null
  input: LinkedInContentPublishInput
}

export type LinkedInContentEngineInput = {
  pool?: LinkedInContentPoolItem[]
  sections?: string[]
  memeSubreddits?: string[]
  redditSubreddits?: string[]
  redditUserAgent?: string
  publicBaseUrl?: string
  historyRepository?: LinkedInContentHistoryRepository | null
}

type LinkedInContentCandidate = LinkedInContentSelection
type TechMemeSource = 'memegen' | 'reddit'
type RedditCandidateFactory = (
  post: RedditPost,
  subreddit: string,
) => LinkedInContentCandidate[]

type RedditListingResponse = {
  data?: {
    children?: RedditChild[]
  }
}

type RedditChild = {
  data?: RedditPost
}

type RedditPost = {
  id?: string
  title?: string
  subreddit?: string
  permalink?: string
  url?: string
  score?: number
  stickied?: boolean
  over_18?: boolean
  is_video?: boolean
  thumbnail?: string
  preview?: {
    images?: Array<{
      source?: {
        url?: string
      }
    }>
  }
}

type NewsRssFeed = (typeof DEFAULT_NEWS_RSS_FEEDS)[number]

export class LinkedInContentEngineService {
  constructor(
    private readonly random = Math.random,
    private readonly fetcher: typeof fetch = defaultFetcher,
  ) {}

  async select(
    input: LinkedInContentEngineInput = {},
  ): Promise<LinkedInContentSelection> {
    const sections = this.createSectionOrder(input)

    for (const section of sections) {
      const selection = await this.selectFromSection(section, input)

      if (selection) {
        return selection
      }
    }

    throw serviceUnavailable(
      'No unused LinkedIn auto-post content is available for the configured sections',
    )
  }

  private createSectionOrder(input: LinkedInContentEngineInput) {
    const allowedSections = input.sections
      ?.map(normalizeSectionName)
      .filter(Boolean)
    const poolSections = input.pool?.map((item) => item.section) ?? []
    const sections =
      allowedSections && allowedSections.length > 0
        ? allowedSections
        : [TECH_MEMES_SECTION, NEWS_SECTION, ...poolSections]

    return this.shuffle([...new Set(sections.map(normalizeSectionName))])
  }

  private async selectFromSection(
    section: string,
    input: LinkedInContentEngineInput,
  ) {
    if (section === TECH_MEMES_SECTION) {
      return this.selectTechMeme(input)
    }

    if (isNewsSection(section)) {
      return this.selectRedditNews(input, section)
    }

    return this.selectFromCandidates(
      createPoolCandidates(input.pool ?? [], section),
      input.historyRepository,
    )
  }

  private async selectRedditNews(
    input: LinkedInContentEngineInput,
    section: string,
  ) {
    const subreddits = this.shuffle(
      normalizeSubreddits(input.redditSubreddits),
    )

    for (const subreddit of subreddits) {
      const candidates = await this.fetchRedditCandidates(
        subreddit,
        input.redditUserAgent,
        (post, candidateSubreddit) =>
          toRedditNewsCandidate(
            post,
            candidateSubreddit,
            section,
            input.publicBaseUrl,
          ),
      )
      const selection = await this.selectFromCandidates(
        candidates,
        input.historyRepository,
      )

      if (selection) {
        return selection
      }
    }

    return this.selectRssNews(input, section)
  }

  private async selectRssNews(
    input: LinkedInContentEngineInput,
    section: string,
  ) {
    const feeds = this.shuffle([...DEFAULT_NEWS_RSS_FEEDS])

    for (const feed of feeds) {
      const candidates = await this.fetchRssNewsCandidates(
        feed,
        section,
        input.publicBaseUrl,
        input.redditUserAgent,
      )
      const selection = await this.selectFromCandidates(
        candidates,
        input.historyRepository,
      )

      if (selection) {
        return selection
      }
    }

    return null
  }

  private async selectTechMeme(input: LinkedInContentEngineInput) {
    const sources: TechMemeSource[] = this.shuffle(['memegen', 'reddit'])

    for (const source of sources) {
      const selection =
        source === 'memegen'
          ? await this.selectMemegenMeme(input)
          : await this.selectRedditMemes(input)

      if (selection) {
        return selection
      }
    }

    return null
  }

  private async selectMemegenMeme(input: LinkedInContentEngineInput) {
    const candidates = createTechMemegenCandidates()
    const templateFreshCandidates = input.historyRepository
      ? await this.preferUnusedMemegenTemplates(
          candidates,
          input.historyRepository,
        )
      : candidates

    return this.selectFromCandidates(
      templateFreshCandidates,
      input.historyRepository,
    )
  }

  private async selectRedditMemes(input: LinkedInContentEngineInput) {
    const subreddits = this.shuffle(
      normalizeMemeSubreddits(input.memeSubreddits),
    )

    for (const subreddit of subreddits) {
      const candidates = await this.fetchRedditCandidates(
        subreddit,
        input.redditUserAgent,
        toRedditMemeCandidate,
      )
      const selection = await this.selectFromCandidates(
        candidates,
        input.historyRepository,
      )

      if (selection) {
        return selection
      }
    }

    return null
  }

  private async preferUnusedMemegenTemplates(
    candidates: LinkedInContentCandidate[],
    historyRepository: LinkedInContentHistoryRepository,
  ) {
    const itemIds = candidates
      .map((candidate) => candidate.itemId)
      .filter((itemId): itemId is string => Boolean(itemId))
    const usedItemIds = await historyRepository.findUsedItemIds(itemIds)
    const usedTemplates = new Set(
      [...usedItemIds]
        .map(readMemegenTemplateFromItemId)
        .filter((template): template is string => Boolean(template)),
    )

    if (usedTemplates.size === 0) {
      return candidates
    }

    const freshTemplateCandidates = candidates.filter((candidate) => {
      const template = readMemegenTemplateFromItemId(candidate.itemId)

      return template ? !usedTemplates.has(template) : true
    })

    return freshTemplateCandidates.length > 0
      ? freshTemplateCandidates
      : candidates
  }

  private async fetchRedditCandidates(
    subreddit: string,
    redditUserAgent: string | undefined,
    createCandidate: RedditCandidateFactory,
  ) {
    const url = new URL(`https://www.reddit.com/r/${subreddit}/top.json`)
    url.searchParams.set('t', 'day')
    url.searchParams.set('limit', String(REDDIT_POST_LIMIT))
    url.searchParams.set('raw_json', '1')

    const response = await this.fetcher(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': redditUserAgent?.trim() || DEFAULT_REDDIT_USER_AGENT,
      },
    })

    if (!response.ok) {
      return []
    }

    const payload = (await response.json()) as RedditListingResponse
    const posts = payload.data?.children ?? []

    return posts
      .map((child) => child.data)
      .filter((post): post is RedditPost => Boolean(post))
      .flatMap((post) => createCandidate(post, subreddit))
  }

  private async fetchRssNewsCandidates(
    feed: NewsRssFeed,
    section: string,
    publicBaseUrl?: string,
    userAgent?: string,
  ) {
    const response = await this.fetcher(feed.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
        'User-Agent': userAgent?.trim() || DEFAULT_REDDIT_USER_AGENT,
      },
    })

    if (!response.ok) {
      return []
    }

    const text = await response.text()
    const parsed = rssParser.parse(text) as unknown
    const items = readRssItems(parsed)

    return items.flatMap((item, index) =>
      toRssNewsCandidate(item, index, feed, section, publicBaseUrl),
    )
  }

  private async selectFromCandidates(
    candidates: LinkedInContentCandidate[],
    historyRepository?: LinkedInContentHistoryRepository | null,
  ) {
    if (candidates.length === 0) {
      return null
    }

    if (!historyRepository) {
      return this.pick(candidates)
    }

    const usedKeys = await historyRepository.findUsedKeys(
      candidates.map((candidate) => candidate.contentKey),
    )
    const unusedCandidates = candidates.filter(
      (candidate) => !usedKeys.has(candidate.contentKey),
    )

    if (unusedCandidates.length === 0) {
      return null
    }

    return this.pick(unusedCandidates)
  }

  private pick<T>(values: T[]) {
    const index = Math.floor(this.random() * values.length)

    return values[Math.min(index, values.length - 1)] as T
  }

  private shuffle<T>(values: T[]) {
    const copy = [...values]

    for (let index = copy.length - 1; index > 0; index -= 1) {
      const nextIndex = Math.floor(this.random() * (index + 1))
      const current = copy[index] as T
      copy[index] = copy[nextIndex] as T
      copy[nextIndex] = current
    }

    return copy
  }
}

export function readLinkedInContentPool(
  value?: string | null,
): LinkedInContentPoolItem[] | undefined {
  const cleaned = value?.trim()

  if (!cleaned) {
    return undefined
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw serviceUnavailable(
      'CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL must be valid JSON',
    )
  }

  if (!Array.isArray(parsed)) {
    throw serviceUnavailable(
      'CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL must be a JSON array',
    )
  }

  return parsed.map(readContentPoolItem)
}

export function readLinkedInContentSections(value?: string | null) {
  return value
    ?.split(/[|,]/)
    .map(normalizeSectionName)
    .filter(Boolean)
}

export function readLinkedInRedditSubreddits(value?: string | null) {
  const subreddits = value
    ?.split(/[|,]/)
    .map(normalizeSubredditName)
    .filter(Boolean)

  return subreddits && subreddits.length > 0
    ? subreddits
    : [...DEFAULT_REDDIT_SUBREDDITS]
}

export function readLinkedInMemeSubreddits(value?: string | null) {
  const subreddits = value
    ?.split(/[|,]/)
    .map(normalizeSubredditName)
    .filter(Boolean)

  return subreddits && subreddits.length > 0
    ? subreddits
    : [...DEFAULT_MEME_SUBREDDITS]
}

function createTechMemegenCandidates() {
  const candidates: LinkedInContentCandidate[] = []

  for (const template of MEMEGEN_TEMPLATES) {
    for (const topLine of memeTopLines) {
      for (const bottomLine of memeBottomLines) {
        const imageUrl = createMemegenUrl(template, topLine, bottomLine)
        const itemId = `${template}:${slugify(topLine)}:${slugify(bottomLine)}`

        candidates.push({
          contentKey: `memegen:${itemId}`,
          section: TECH_MEMES_SECTION,
          itemId,
          sourceUrl: imageUrl,
          input: {
            topic: truncateText(`${topLine}: ${bottomLine}`, 180),
            audience: 'developers and engineering teams',
            objective:
              'turn a familiar engineering moment into a useful reminder',
            keyPoints: [
              'The joke lands because the workflow is real',
              'Good automation turns surprises into visible signals',
              'Small delivery habits save large recovery time',
            ],
            tone: 'conversational',
            callToAction: 'Which tech meme describes your week right now?',
            imageUrl,
            imageTitle: truncateText(`${topLine} / ${bottomLine}`, 180),
            imageDescription: 'A generated tech meme for LinkedIn.',
            imageAltText: truncateText(
              `Tech meme reading ${topLine}. ${bottomLine}.`,
              240,
            ),
          },
        })
      }
    }
  }

  return candidates
}

function createPoolCandidates(pool: LinkedInContentPoolItem[], section: string) {
  return pool
    .filter((item) => normalizeSectionName(item.section) === section)
    .map((item) => {
      const input = toPublishInput(item)
      const itemId =
        item.id ??
        slugify(input.imageUrl ?? input.articleUrl ?? input.topic ?? section)

      return {
        contentKey: `pool:${section}:${itemId}`,
        section,
        itemId,
        sourceUrl: item.sourceUrl ?? input.articleUrl ?? input.imageUrl ?? null,
        input,
      }
    })
}

function toPublishInput(item: LinkedInContentPoolItem) {
  const input: LinkedInContentPublishInput = {
    topic: item.topic,
  }

  assignOptional(input, 'audience', item.audience)
  assignOptional(input, 'objective', item.objective)
  assignOptional(input, 'keyPoints', item.keyPoints)
  assignOptional(input, 'tone', item.tone)
  assignOptional(input, 'callToAction', item.callToAction)
  assignOptional(input, 'articleUrl', item.articleUrl)
  assignOptional(input, 'articleTitle', item.articleTitle)
  assignOptional(input, 'articleDescription', item.articleDescription)
  assignOptional(input, 'imageUrl', item.imageUrl)
  assignOptional(input, 'imageTitle', item.imageTitle)
  assignOptional(input, 'imageDescription', item.imageDescription)
  assignOptional(input, 'imageAltText', item.imageAltText)
  assignOptional(input, 'visibility', item.visibility)

  if (item.sourceUrl) {
    if (!input.articleUrl && !input.imageUrl) {
      input.articleUrl = item.sourceUrl
    } else if (input.imageUrl) {
      appendSourceReference(input, item.sourceUrl)
    }
  }

  return input
}

function toRedditNewsCandidate(
  post: RedditPost,
  subreddit: string,
  section: string,
  publicBaseUrl?: string,
) {
  if (post.stickied || post.over_18 || post.is_video) {
    return []
  }

  const title = post.title?.trim()
  const postId = post.id?.trim()
  const sourceImageUrl = toHighResolutionNewsImageUrl(readRedditImageUrl(post))

  if (!title || !postId || !sourceImageUrl) {
    return []
  }

  const discussionUrl = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/r/${subreddit}`
  const sourceUrl =
    post.url && post.url !== sourceImageUrl && isHttpUrl(post.url)
      ? post.url
      : discussionUrl
  const imageUrl = publicBaseUrl
    ? createLinkedInNewsCardImageUrl(publicBaseUrl, {
        title,
        summary: `Trending via r/${subreddit} today`,
        sourceLabel: `r/${subreddit}`,
        sourceImageUrl,
        requireSourceImage: true,
      })
    : sourceImageUrl

  if (!imageUrl) {
    return []
  }

  const input: LinkedInContentPublishInput = {
    topic: truncateText(title, 180),
    audience: 'professionals, founders, policy watchers, and curious readers',
    objective: `turn a timely news discussion from r/${subreddit} into a clear LinkedIn story`,
    keyPoints: [
      `News source: r/${subreddit}`,
      `Reddit score: ${typeof post.score === 'number' ? post.score : 0}`,
      'Cover the story as general news, not only technology news',
      'Do not add claims beyond what the image, title, and source support',
    ],
    tone: 'professional',
    callToAction: 'What is your take on this?',
    imageUrl,
    imageTitle: truncateText(title, 180),
    imageDescription: `Editorial news card based on a top r/${subreddit} discussion from today.`,
    imageAltText: truncateText(`News card titled: ${title}`, 240),
  }

  appendSourceReference(input, sourceUrl)

  return [
    {
      contentKey: `reddit-news:${subreddit}:${postId}:${
        sourceImageUrl ?? sourceUrl
      }`,
      section,
      itemId: `reddit:${subreddit}:${postId}`,
      sourceUrl,
      input,
    },
  ]
}

function toRssNewsCandidate(
  item: Record<string, unknown>,
  index: number,
  feed: NewsRssFeed,
  section: string,
  publicBaseUrl?: string,
) {
  const rawTitle = readRssString(item.title)
  const sourceUrl = cleanOptionalHttpUrl(
    readRssString(item.link) ?? readRssGuid(item),
  )

  if (!rawTitle || !sourceUrl) {
    return []
  }

  const title = cleanRssTitle(rawTitle)
  const summary = truncateText(
    stripHtml(readRssString(item.description) ?? ''),
    180,
  )
  const sourceLabel =
    readRssSourceLabel(item.source) ?? feed.sourceLabel ?? readHostLabel(sourceUrl)
  const sourceImageUrl = toHighResolutionNewsImageUrl(readRssImageUrl(item))

  if (!sourceImageUrl) {
    return []
  }

  const imageUrl = publicBaseUrl
    ? createLinkedInNewsCardImageUrl(publicBaseUrl, {
        title,
        summary,
        sourceLabel,
        sourceImageUrl,
        requireSourceImage: true,
      })
    : sourceImageUrl

  if (!imageUrl) {
    return []
  }

  const sourceKey = hashString(sourceUrl)
  const input: LinkedInContentPublishInput = {
    topic: truncateText(title, 180),
    audience: 'professionals, founders, policy watchers, and curious readers',
    objective: `turn a timely news item from ${sourceLabel} into a clear LinkedIn story`,
    keyPoints: [
      `News source: ${sourceLabel}`,
      'Cover the story as general news, not only technology news',
      'Do not add claims beyond what the image, title, and source support',
    ],
    tone: 'professional',
    callToAction: 'What is your take on this?',
    imageUrl,
    imageTitle: truncateText(title, 180),
    imageDescription: `Editorial news card based on ${sourceLabel}.`,
    imageAltText: truncateText(`News card titled: ${title}`, 240),
  }

  if (summary) {
    input.keyPoints = [...(input.keyPoints ?? []), truncateText(summary, 220)]
  }

  appendSourceReference(input, sourceUrl)

  return [
    {
      contentKey: `rss-news:${hashString(feed.url)}:${sourceKey}`,
      section,
      itemId: `rss:${slugify(sourceLabel)}:${sourceKey || index}`,
      sourceUrl,
      input,
    },
  ]
}

function toRedditMemeCandidate(post: RedditPost, subreddit: string) {
  if (post.stickied || post.over_18 || post.is_video) {
    return []
  }

  const title = post.title?.trim()
  const postId = post.id?.trim()
  const imageUrl = readRedditImageUrl(post)

  if (!title || !postId || !imageUrl) {
    return []
  }

  const discussionUrl = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/r/${subreddit}`
  const sourceUrl =
    post.url && post.url !== imageUrl && isHttpUrl(post.url)
      ? post.url
      : discussionUrl
  const input: LinkedInContentPublishInput = {
    topic: truncateText(title, 180),
    audience: 'developers and engineering teams',
    objective: `turn a programming meme from r/${subreddit} into a useful engineering reminder`,
    keyPoints: [
      `Meme source: r/${subreddit}`,
      `Reddit score: ${typeof post.score === 'number' ? post.score : 0}`,
      'Connect the joke to one practical delivery habit',
    ],
    tone: 'conversational',
    callToAction: 'Which tech meme describes your week right now?',
    imageUrl,
    imageTitle: truncateText(title, 180),
    imageDescription: `Top r/${subreddit} meme from today.`,
    imageAltText: truncateText(`Image from Reddit meme titled: ${title}`, 240),
  }

  appendSourceReference(input, sourceUrl)

  return [
    {
      contentKey: `reddit-meme:${subreddit}:${postId}:${imageUrl}`,
      section: TECH_MEMES_SECTION,
      itemId: `reddit-meme:${subreddit}:${postId}`,
      sourceUrl,
      input,
    },
  ]
}

function readRssItems(value: unknown) {
  if (!isRecord(value)) {
    return []
  }

  const rss = value.rss
  const feed = value.feed
  const channel = isRecord(rss) ? rss.channel : null
  const rssItems = isRecord(channel) ? channel.item : null
  const atomEntries = isRecord(feed) ? feed.entry : null

  return toRecordArray(rssItems ?? atomEntries)
}

function toRecordArray(value: unknown) {
  const values = Array.isArray(value) ? value : value ? [value] : []

  return values.filter(isRecord)
}

function readRssString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (!isRecord(value)) {
    return null
  }

  return readRssString(value['#text'] ?? value._text ?? value._)
}

function readRssGuid(item: Record<string, unknown>) {
  const guid = item.guid

  if (typeof guid === 'string') {
    return guid
  }

  if (isRecord(guid)) {
    return readRssString(guid['#text']) ?? readRssString(guid.id)
  }

  return null
}

function readRssSourceLabel(value: unknown) {
  const source = readRssString(value)

  if (source) {
    return source
  }

  if (isRecord(value)) {
    return readRssString(value.title) ?? readRssString(value.url)
  }

  return null
}

function readRssImageUrl(item: Record<string, unknown>) {
  for (const key of [
    'media:thumbnail',
    'media:content',
    'enclosure',
    'image',
  ]) {
    const image = readRssImageUrlValue(item[key])

    if (image) {
      return image
    }
  }

  return null
}

function readRssImageUrlValue(value: unknown): string | null {
  const values = Array.isArray(value) ? value : value ? [value] : []

  for (const item of values) {
    if (typeof item === 'string' && isHttpUrl(item)) {
      return item
    }

    if (!isRecord(item)) {
      continue
    }

    const candidate =
      readRssString(item.url) ??
      readRssString(item.href) ??
      readRssString(item.link)

    if (candidate && isHttpUrl(candidate)) {
      return candidate
    }
  }

  return null
}

function toHighResolutionNewsImageUrl(value: string | null) {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value.replace(/&amp;/g, '&'))
    const host = url.hostname.toLowerCase()

    if (host === 'ichef.bbci.co.uk') {
      url.pathname = url.pathname.replace(
        /\/standard\/\d+\//,
        '/standard/1024/',
      )
    }

    return url.toString()
  } catch {
    return value
  }
}

function cleanOptionalHttpUrl(value: string | null) {
  if (!value) {
    return null
  }

  return isHttpUrl(value) ? value : null
}

function cleanRssTitle(value: string) {
  return stripHtml(value)
    .replace(/\s+-\s+Google News$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function readHostLabel(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '')

    return host || 'News'
  } catch {
    return 'News'
  }
}

function hashString(value: string) {
  let hash = 5381

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }

  return (hash >>> 0).toString(36)
}

function appendSourceReference(
  input: LinkedInContentPublishInput,
  sourceUrl: string,
) {
  const sourceLine = `Source: ${sourceUrl}`

  if (sourceLine.length > 240) {
    return
  }

  const keyPoints = input.keyPoints ?? []

  if (keyPoints.length < 8 && !keyPoints.includes(sourceLine)) {
    input.keyPoints = [...keyPoints, sourceLine]
    return
  }

  if (!input.callToAction) {
    input.callToAction = sourceLine
  }
}

function isNewsSection(section: string) {
  return section === NEWS_SECTION || section === LEGACY_TECH_NEWS_SECTION
}

function readRedditImageUrl(post: RedditPost) {
  const previewUrl = post.preview?.images?.[0]?.source?.url?.replace(
    /&amp;/g,
    '&',
  )

  if (previewUrl && isHttpUrl(previewUrl)) {
    return previewUrl
  }

  if (post.url && isHttpUrl(post.url) && looksLikeImageUrl(post.url)) {
    return post.url
  }

  if (
    post.thumbnail &&
    isHttpUrl(post.thumbnail) &&
    post.thumbnail.length > 20
  ) {
    return post.thumbnail
  }

  return null
}

function createMemegenUrl(
  template: (typeof MEMEGEN_TEMPLATES)[number],
  topLine: string,
  bottomLine: string,
) {
  return `https://api.memegen.link/images/${template}/${toMemegenSegment(
    topLine,
  )}/${toMemegenSegment(bottomLine)}.png`
}

function readMemegenTemplateFromItemId(itemId: string | null) {
  const [template] = itemId?.split(':') ?? []

  return template || null
}

function toMemegenSegment(value: string) {
  return encodeURIComponent(value.trim().replace(/\s+/g, '_'))
}

function readContentPoolItem(value: unknown, index: number) {
  const context = `CONTENT_LINKEDIN_AUTO_POST_CONTENT_POOL[${index}]`

  if (!isRecord(value)) {
    throw serviceUnavailable(`${context} must be an object`)
  }

  const item: LinkedInContentPoolItem = {
    section: normalizeSectionName(
      readRequiredString(value, 'section', context),
    ),
    topic: readRequiredString(value, 'topic', context),
  }
  const id = readOptionalString(value, 'id', context)
  const audience = readOptionalString(value, 'audience', context)
  const objective = readOptionalString(value, 'objective', context)
  const keyPoints = readOptionalStringList(value, 'keyPoints', context)
  const tone = readOptionalTone(value, context)
  const callToAction = readOptionalString(value, 'callToAction', context)
  const articleUrl = readOptionalString(value, 'articleUrl', context)
  const articleTitle = readOptionalString(value, 'articleTitle', context)
  const articleDescription = readOptionalString(
    value,
    'articleDescription',
    context,
  )
  const imageUrl = readOptionalString(value, 'imageUrl', context)
  const imageTitle = readOptionalString(value, 'imageTitle', context)
  const imageDescription = readOptionalString(
    value,
    'imageDescription',
    context,
  )
  const imageAltText = readOptionalString(value, 'imageAltText', context)
  const sourceUrl = readOptionalString(value, 'sourceUrl', context)
  const visibility = readOptionalVisibility(value, context)

  assignOptional(item, 'id', id)
  assignOptional(item, 'audience', audience)
  assignOptional(item, 'objective', objective)
  assignOptional(item, 'keyPoints', keyPoints)
  assignOptional(item, 'tone', tone)
  assignOptional(item, 'callToAction', callToAction)
  assignOptional(item, 'articleUrl', articleUrl)
  assignOptional(item, 'articleTitle', articleTitle)
  assignOptional(item, 'articleDescription', articleDescription)
  assignOptional(item, 'imageUrl', imageUrl)
  assignOptional(item, 'imageTitle', imageTitle)
  assignOptional(item, 'imageDescription', imageDescription)
  assignOptional(item, 'imageAltText', imageAltText)
  assignOptional(item, 'sourceUrl', sourceUrl)
  assignOptional(item, 'visibility', visibility)

  if (!item.section) {
    throw serviceUnavailable(`${context}.section is required`)
  }

  return item
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  context: string,
) {
  const result = readOptionalString(value, key, context)

  if (!result) {
    throw serviceUnavailable(`${context}.${key} is required`)
  }

  return result
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  context: string,
) {
  const field = value[key]

  if (field === undefined || field === null) {
    return undefined
  }

  if (typeof field !== 'string') {
    throw serviceUnavailable(`${context}.${key} must be a string`)
  }

  const cleaned = field.trim()

  return cleaned || undefined
}

function readOptionalStringList(
  value: Record<string, unknown>,
  key: string,
  context: string,
) {
  const field = value[key]

  if (field === undefined || field === null) {
    return undefined
  }

  if (typeof field === 'string') {
    return field
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (!Array.isArray(field)) {
    throw serviceUnavailable(`${context}.${key} must be a string array`)
  }

  return field
    .map((item, itemIndex) => {
      if (typeof item !== 'string') {
        throw serviceUnavailable(
          `${context}.${key}[${itemIndex}] must be a string`,
        )
      }

      return item.trim()
    })
    .filter(Boolean)
}

function readOptionalTone(
  value: Record<string, unknown>,
  context: string,
): LinkedInContentTone | undefined {
  const tone = readOptionalString(value, 'tone', context)

  if (tone === undefined) {
    return undefined
  }

  if (!LINKEDIN_CONTENT_TONES.includes(tone as LinkedInContentTone)) {
    throw serviceUnavailable(
      `${context}.tone must be professional, conversational, educational, or bold`,
    )
  }

  return tone as LinkedInContentTone
}

function readOptionalVisibility(
  value: Record<string, unknown>,
  context: string,
): LinkedInVisibility | undefined {
  const visibility = readOptionalString(value, 'visibility', context)

  if (visibility === undefined) {
    return undefined
  }

  if (!LINKEDIN_VISIBILITY_VALUES.includes(visibility as LinkedInVisibility)) {
    throw serviceUnavailable(
      `${context}.visibility must be PUBLIC, LOGGED_IN, CONNECTIONS, or CONTAINER`,
    )
  }

  return visibility as LinkedInVisibility
}

function assignOptional<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
) {
  if (value !== undefined) {
    target[key] = value
  }
}

function normalizeSectionName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function normalizeSubreddits(value?: readonly string[] | null) {
  const subreddits = value
    ?.map(normalizeSubredditName)
    .filter(Boolean)

  return subreddits && subreddits.length > 0
    ? subreddits
    : [...DEFAULT_REDDIT_SUBREDDITS]
}

function normalizeMemeSubreddits(value?: readonly string[] | null) {
  const subreddits = value
    ?.map(normalizeSubredditName)
    .filter(Boolean)

  return subreddits && subreddits.length > 0
    ? subreddits
    : [...DEFAULT_MEME_SUBREDDITS]
}

function normalizeSubredditName(value: string) {
  return value.trim().replace(/^r\//i, '')
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return value.slice(0, maxLength - 3).trimEnd() + '...'
}

function looksLikeImageUrl(value: string) {
  try {
    const url = new URL(value)

    return /\.(gif|jpe?g|png|webp)$/i.test(url.pathname)
  } catch {
    return false
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)

    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
