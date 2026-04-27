import { badRequest } from '../../../../shared/http/errors'
import {
  LINKEDIN_CONTENT_TONES,
  type LinkedInContentDraft,
  type LinkedInContentInput,
  type LinkedInContentTone,
} from '../domain/linkedin-content.entity'

const MAX_LINKEDIN_POST_LENGTH = 3000
const MAX_KEY_POINTS = 8
const MAX_FIELD_LENGTH = 240
const MAX_TOPIC_LENGTH = 180
const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'the',
  'this',
  'to',
  'we',
  'with',
  'your',
])

export class CreateLinkedInContentService {
  execute(input: LinkedInContentInput): LinkedInContentDraft {
    const normalized = this.normalizeInput(input)
    const hashtags = this.createHashtags(normalized)
    const text = this.createPostText(normalized, hashtags)

    if (text.length > MAX_LINKEDIN_POST_LENGTH) {
      throw badRequest(
        'Generated LinkedIn content is too long; reduce the topic, key points, or call to action',
      )
    }

    return {
      platform: 'linkedin',
      text,
      characterCount: text.length,
      hashtags,
      generatedAt: new Date().toISOString(),
    }
  }

  private normalizeInput(
    input: LinkedInContentInput,
  ): Required<LinkedInContentInput> {
    const topic = this.cleanRequired(input.topic, 'topic', MAX_TOPIC_LENGTH)
    const audience = this.cleanOptional(input.audience, 'audience')
    const objective = this.cleanOptional(input.objective, 'objective')
    const callToAction = this.cleanOptional(input.callToAction, 'callToAction')
    const tone = this.cleanTone(input.tone)
    const keyPoints = this.cleanKeyPoints(input.keyPoints)

    return {
      topic,
      audience: audience ?? '',
      objective: objective ?? '',
      keyPoints,
      tone,
      callToAction: callToAction ?? '',
    }
  }

  private createPostText(
    input: Required<LinkedInContentInput>,
    hashtags: string[],
  ) {
    const lines: string[] = [this.createHook(input.topic, input.tone)]

    if (input.audience || input.objective) {
      lines.push('')
      lines.push(this.createContextLine(input))
    }

    lines.push('')

    if (input.keyPoints.length > 0) {
      lines.push('What matters most:')
      lines.push(...input.keyPoints.map((point) => `- ${point}`))
    } else {
      lines.push(`The useful question is simple: what changes when ${input.topic}?`)
      lines.push(
        'Start with the smallest repeatable step, measure the signal, and keep the learning loop visible.',
      )
    }

    if (input.callToAction) {
      lines.push('')
      lines.push(input.callToAction)
    }

    if (hashtags.length > 0) {
      lines.push('')
      lines.push(hashtags.join(' '))
    }

    return lines.join('\n')
  }

  private createHook(topic: string, tone: LinkedInContentTone) {
    switch (tone) {
      case 'bold':
        return `${topic} is no longer optional.`
      case 'conversational':
        return `I have been thinking about ${topic}.`
      case 'educational':
        return `A practical way to understand ${topic}:`
      case 'professional':
      default:
        return `${topic} deserves a clearer operating model.`
    }
  }

  private createContextLine(input: Required<LinkedInContentInput>) {
    if (input.audience && input.objective) {
      return `For ${input.audience}, the goal is ${input.objective}.`
    }

    if (input.audience) {
      return `For ${input.audience}, the opportunity is to make the next step easier to act on.`
    }

    return `The goal is ${input.objective}.`
  }

  private createHashtags(input: Required<LinkedInContentInput>) {
    const words = `${input.topic} ${input.objective}`
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !stopWords.has(word))

    const uniqueWords = [...new Set(words)].slice(0, 4)

    return uniqueWords.map(
      (word) => `#${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`,
    )
  }

  private cleanRequired(value: string, fieldName: string, maxLength: number) {
    if (typeof value !== 'string') {
      throw badRequest(`${fieldName} is required`)
    }

    const cleaned = value.trim()

    if (!cleaned) {
      throw badRequest(`${fieldName} is required`)
    }

    if (cleaned.length > maxLength) {
      throw badRequest(`${fieldName} must be ${maxLength} characters or fewer`)
    }

    return cleaned
  }

  private cleanOptional(value: string | undefined, fieldName: string) {
    if (value === undefined) {
      return undefined
    }

    if (typeof value !== 'string') {
      throw badRequest(`${fieldName} must be a string`)
    }

    const cleaned = value.trim()

    if (!cleaned) {
      return undefined
    }

    if (cleaned.length > MAX_FIELD_LENGTH) {
      throw badRequest(
        `${fieldName} must be ${MAX_FIELD_LENGTH} characters or fewer`,
      )
    }

    return cleaned
  }

  private cleanTone(value: LinkedInContentTone | undefined) {
    if (value === undefined) {
      return 'professional'
    }

    if (!LINKEDIN_CONTENT_TONES.includes(value)) {
      throw badRequest(
        'tone must be one of professional, conversational, educational, or bold',
      )
    }

    return value
  }

  private cleanKeyPoints(value: string[] | undefined) {
    if (value === undefined) {
      return []
    }

    if (!Array.isArray(value)) {
      throw badRequest('keyPoints must be an array of strings')
    }

    if (value.length > MAX_KEY_POINTS) {
      throw badRequest(`keyPoints must include ${MAX_KEY_POINTS} items or fewer`)
    }

    return value
      .map((point) => this.cleanRequired(point, 'keyPoints item', MAX_FIELD_LENGTH))
      .filter(Boolean)
  }
}
