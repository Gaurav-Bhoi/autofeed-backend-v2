export const LINKEDIN_CONTENT_TONES = [
  'professional',
  'conversational',
  'educational',
  'bold',
] as const

export type LinkedInContentTone = (typeof LINKEDIN_CONTENT_TONES)[number]

export type LinkedInContentInput = {
  topic: string
  audience?: string
  objective?: string
  keyPoints?: string[]
  tone?: LinkedInContentTone
  callToAction?: string
}

export type LinkedInContentDraft = {
  platform: 'linkedin'
  text: string
  characterCount: number
  hashtags: string[]
  generatedAt: string
}
