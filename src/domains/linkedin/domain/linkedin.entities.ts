export const DEFAULT_LINKEDIN_SCOPES = [
  'openid',
  'profile',
  'email',
  'w_member_social',
] as const

export const LINKEDIN_VISIBILITY_VALUES = [
  'PUBLIC',
  'LOGGED_IN',
  'CONNECTIONS',
  'CONTAINER',
] as const

export type LinkedInVisibility = (typeof LINKEDIN_VISIBILITY_VALUES)[number]

export const LINKEDIN_CONTENT_AUTOMATION_STATUS_VALUES = [
  'start',
  'stop',
] as const

export type LinkedInContentAutomationStatus =
  (typeof LINKEDIN_CONTENT_AUTOMATION_STATUS_VALUES)[number]

export type LinkedInTokenSet = {
  accessToken: string
  expiresIn: number
  tokenType: string
  scopes: string[]
  idToken: string | null
  refreshToken: string | null
  refreshTokenExpiresIn: number | null
}

export type LinkedInProfile = {
  id: string
  authorUrn: string
  name: string | null
  givenName: string | null
  familyName: string | null
  picture: string | null
  email: string | null
  emailVerified: boolean | null
  locale: string | null
}

export type LinkedInLoginResult = {
  authorizationUrl: string
  state: string
  scopes: string[]
  redirectUri: string
}

export type LinkedInStoredAccount = {
  id: string
  linkedinMemberId: string
  authorUrn: string
  email: string | null
  name: string | null
  givenName: string | null
  familyName: string | null
  picture: string | null
  locale: string | null
  scopes: string[]
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string | null
  contentAutomationStatus: LinkedInContentAutomationStatus
  contentAutomationStartedAt: string | null
  contentAutomationStoppedAt: string | null
  contentAutomationUpdatedAt: string | null
  lastLoginAt: string
  loginCount: number
  createdAt: string
  updatedAt: string
}

export type LinkedInPublishAccount = LinkedInStoredAccount & {
  accessToken: string
  tokenType: string
}

export type FindLinkedInStoredAccountInput = {
  accountId?: string
  linkedinMemberId?: string
}

export type LinkedInDashboardAccount = {
  id: string
  linkedinMemberId: string
  authorUrn: string
  email: string | null
  name: string | null
  givenName: string | null
  familyName: string | null
  picture: string | null
  locale: string | null
  scopes: string[]
  accessTokenExpiresAt: string
  accessTokenExpired: boolean
  refreshTokenAvailable: boolean
  refreshTokenExpiresAt: string | null
  refreshTokenExpired: boolean | null
  contentAutomationStatus: LinkedInContentAutomationStatus
  contentAutomationStartedAt: string | null
  contentAutomationStoppedAt: string | null
  contentAutomationUpdatedAt: string | null
  lastLoginAt: string
  loginCount: number
  createdAt: string
  updatedAt: string
}

export type LinkedInDashboardResult = {
  connected: boolean
  account: LinkedInDashboardAccount | null
}

export type PersistLinkedInLoginInput = {
  profile: LinkedInProfile
  tokens: LinkedInTokenSet
  state: string | null
  requestId: string | null
  loggedInAt: string
}

export type LinkedInCallbackResult = {
  tokens: LinkedInTokenSet
  profile: LinkedInProfile
  storedAccount: LinkedInStoredAccount
}

export type LinkedInPostInput = {
  text: string
  articleUrl?: string
  articleTitle?: string
  articleDescription?: string
  imageUrl?: string
  imageTitle?: string
  imageDescription?: string
  imageAltText?: string
  visibility?: LinkedInVisibility
}

export type LinkedInCreatePostInput = Omit<LinkedInPostInput, 'imageUrl'> & {
  imageAssetUrn?: string
}

export type LinkedInImageUploadInput = {
  imageUrl: string
}

export type LinkedInUploadedImage = {
  asset: string
  uploadUrl: string
  contentType: string
  byteLength: number
}

export type LinkedInPublishedPost = {
  id: string | null
  authorUrn: string
  lifecycleState: 'PUBLISHED'
  visibility: LinkedInVisibility
  commentary: string
  mediaCategory: 'NONE' | 'ARTICLE' | 'IMAGE'
  imageAssetUrn: string | null
}

export type LinkedInAuthConfig = {
  clientId: string
  clientSecret?: string
  redirectUri: string
}

export type LinkedInTokenApiResponse = {
  access_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  id_token?: string
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
  message?: string
}

export type LinkedInUserInfoResponse = {
  sub?: string
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  email?: string
  email_verified?: boolean
  locale?: string
  message?: string
}

export function normalizeLinkedInScopes(scopes?: Iterable<string>) {
  const source = scopes ?? DEFAULT_LINKEDIN_SCOPES
  const normalized = new Set<string>()

  for (const scope of source) {
    const value = scope.trim()

    if (value) {
      normalized.add(value)
    }
  }

  if (normalized.size === 0) {
    for (const scope of DEFAULT_LINKEDIN_SCOPES) {
      normalized.add(scope)
    }
  }

  return [...normalized]
}

export function buildLinkedInAuthorizationUrl(input: {
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string
}) {
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scopes.join(' '))
  url.searchParams.set('state', input.state)

  return url.toString()
}

export function buildPersonUrn(memberId: string) {
  return `urn:li:person:${memberId}`
}

export function toLinkedInProfile(
  profile: LinkedInUserInfoResponse,
): LinkedInProfile {
  const memberId = profile.sub ?? ''

  return {
    id: memberId,
    authorUrn: buildPersonUrn(memberId),
    name: profile.name ?? null,
    givenName: profile.given_name ?? null,
    familyName: profile.family_name ?? null,
    picture: profile.picture ?? null,
    email: profile.email ?? null,
    emailVerified:
      typeof profile.email_verified === 'boolean' ? profile.email_verified : null,
    locale: profile.locale ?? null,
  }
}

export function buildLinkedInPostPayload(
  authorUrn: string,
  input: LinkedInCreatePostInput,
) {
  const mediaCategory = input.imageAssetUrn
    ? 'IMAGE'
    : input.articleUrl
      ? 'ARTICLE'
      : 'NONE'
  const media =
    mediaCategory === 'IMAGE'
      ? [
          {
            status: 'READY',
            media: input.imageAssetUrn,
            ...(input.imageTitle
              ? {
                  title: {
                    text: input.imageTitle,
                  },
                }
              : {}),
            ...(input.imageDescription || input.imageAltText
              ? {
                  description: {
                    text: input.imageDescription ?? input.imageAltText,
                  },
                }
              : {}),
          },
        ]
      : input.articleUrl === undefined
        ? []
        : [
            {
              status: 'READY',
              originalUrl: input.articleUrl,
              title: {
                text: input.articleTitle ?? input.articleUrl,
              },
              ...(input.articleDescription
                ? {
                    description: {
                      text: input.articleDescription,
                    },
                  }
                : {}),
            },
          ]

  return {
    author: authorUrn,
    lifecycleState: 'PUBLISHED' as const,
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: {
          text: input.text,
        },
        shareMediaCategory: mediaCategory,
        media,
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': input.visibility ?? 'PUBLIC',
    },
  }
}
