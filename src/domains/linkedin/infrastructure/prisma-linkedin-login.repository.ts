import type { Prisma } from '../../../generated/prisma/client'
import type {
  LinkedInAccount as PrismaLinkedInAccount,
  PrismaClient,
} from '../../../generated/prisma/client'
import type { LinkedInLoginRepository } from '../domain/linkedin-login.repository'
import type {
  FindLinkedInStoredAccountInput,
  LinkedInContentAutomationStatus,
  LinkedInPublishAccount,
  LinkedInStoredAccount,
  PersistLinkedInLoginInput,
} from '../domain/linkedin.entities'
import { normalizeLinkedInScopes } from '../domain/linkedin.entities'

export class PrismaLinkedInLoginRepository implements LinkedInLoginRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async saveLogin(input: PersistLinkedInLoginInput): Promise<LinkedInStoredAccount> {
    const loggedInAt = new Date(input.loggedInAt)
    const accessTokenExpiresAt = new Date(
      loggedInAt.getTime() + input.tokens.expiresIn * 1000,
    )
    const refreshTokenExpiresAt =
      input.tokens.refreshTokenExpiresIn === null
        ? null
        : new Date(
            loggedInAt.getTime() + input.tokens.refreshTokenExpiresIn * 1000,
          )
    const account = await this.prisma.linkedInAccount.upsert({
      where: {
        linkedinMemberId: input.profile.id,
      },
      update: {
        authorUrn: input.profile.authorUrn,
        email: input.profile.email,
        emailVerified: input.profile.emailVerified,
        fullName: input.profile.name,
        givenName: input.profile.givenName,
        familyName: input.profile.familyName,
        pictureUrl: input.profile.picture,
        locale: input.profile.locale,
        accessToken: input.tokens.accessToken,
        accessTokenExpiresAt,
        tokenType: input.tokens.tokenType,
        scopesJson: toScopesJson(input.tokens.scopes),
        idToken: input.tokens.idToken,
        refreshToken: input.tokens.refreshToken,
        refreshTokenExpiresAt,
        profileJson: toProfileJson(input),
        lastState: input.state,
        lastRequestId: input.requestId,
        lastLoginAt: loggedInAt,
        loginCount: {
          increment: 1,
        },
      },
      create: {
        id: crypto.randomUUID(),
        linkedinMemberId: input.profile.id,
        authorUrn: input.profile.authorUrn,
        email: input.profile.email,
        emailVerified: input.profile.emailVerified,
        fullName: input.profile.name,
        givenName: input.profile.givenName,
        familyName: input.profile.familyName,
        pictureUrl: input.profile.picture,
        locale: input.profile.locale,
        accessToken: input.tokens.accessToken,
        accessTokenExpiresAt,
        tokenType: input.tokens.tokenType,
        scopesJson: toScopesJson(input.tokens.scopes),
        idToken: input.tokens.idToken,
        refreshToken: input.tokens.refreshToken,
        refreshTokenExpiresAt,
        profileJson: toProfileJson(input),
        lastState: input.state,
        lastRequestId: input.requestId,
        lastLoginAt: loggedInAt,
        loginCount: 1,
      },
    })

    return toStoredAccount(account)
  }

  async findAccount(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInStoredAccount | null> {
    const where = buildWhereInput(input)
    const account = await this.prisma.linkedInAccount.findFirst({
      ...(where
        ? {
            where,
          }
        : {}),
      orderBy: {
        lastLoginAt: 'desc',
      },
    })

    return account ? toStoredAccount(account) : null
  }

  async findPublishableAccount(
    input?: FindLinkedInStoredAccountInput,
  ): Promise<LinkedInPublishAccount | null> {
    const where = buildWhereInput(input)
    const account = await this.prisma.linkedInAccount.findFirst({
      ...(where
        ? {
            where,
          }
        : {}),
      orderBy: {
        lastLoginAt: 'desc',
      },
    })

    return account ? toPublishAccount(account) : null
  }

  async updateContentAutomationStatus(input: {
    accountId: string
    status: LinkedInContentAutomationStatus
    changedAt: string
  }): Promise<LinkedInStoredAccount | null> {
    const changedAt = new Date(input.changedAt)
    const account = await this.prisma.linkedInAccount.update({
      where: {
        id: input.accountId,
      },
      data: {
        contentAutomationStatus: input.status,
        contentAutomationUpdatedAt: changedAt,
        ...(input.status === 'start'
          ? {
              contentAutomationStartedAt: changedAt,
            }
          : {
              contentAutomationStoppedAt: changedAt,
            }),
      },
    })

    return toStoredAccount(account)
  }
}

function buildWhereInput(input?: FindLinkedInStoredAccountInput) {
  if (!input?.accountId && !input?.linkedinMemberId) {
    return undefined
  }

  const filters: Prisma.LinkedInAccountWhereInput[] = []

  if (input.accountId) {
    filters.push({
      id: input.accountId,
    })
  }

  if (input.linkedinMemberId) {
    filters.push({
      linkedinMemberId: input.linkedinMemberId,
    })
  }

  return filters.length === 1
    ? filters[0]
    : {
        AND: filters,
      }
}

function toScopesJson(scopes: string[]): Prisma.InputJsonValue {
  return normalizeLinkedInScopes(scopes)
}

function toProfileJson(
  input: PersistLinkedInLoginInput,
): Prisma.InputJsonObject {
  return {
    id: input.profile.id,
    authorUrn: input.profile.authorUrn,
    name: input.profile.name,
    givenName: input.profile.givenName,
    familyName: input.profile.familyName,
    picture: input.profile.picture,
    email: input.profile.email,
    emailVerified: input.profile.emailVerified,
    locale: input.profile.locale,
    scopes: input.tokens.scopes,
    tokenType: input.tokens.tokenType,
  }
}

function toStoredAccount(account: PrismaLinkedInAccount): LinkedInStoredAccount {
  return {
    id: account.id,
    linkedinMemberId: account.linkedinMemberId,
    authorUrn: account.authorUrn,
    email: account.email,
    name: account.fullName,
    givenName: account.givenName,
    familyName: account.familyName,
    picture: account.pictureUrl,
    locale: normalizeLocale(account.locale),
    scopes: readStringArray(account.scopesJson),
    accessTokenExpiresAt: account.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt:
      account.refreshTokenExpiresAt === null
        ? null
        : account.refreshTokenExpiresAt.toISOString(),
    contentAutomationStatus: normalizeContentAutomationStatus(
      account.contentAutomationStatus,
    ),
    contentAutomationStartedAt:
      account.contentAutomationStartedAt === null
        ? null
        : account.contentAutomationStartedAt.toISOString(),
    contentAutomationStoppedAt:
      account.contentAutomationStoppedAt === null
        ? null
        : account.contentAutomationStoppedAt.toISOString(),
    contentAutomationUpdatedAt:
      account.contentAutomationUpdatedAt === null
        ? null
        : account.contentAutomationUpdatedAt.toISOString(),
    lastLoginAt: account.lastLoginAt.toISOString(),
    loginCount: account.loginCount,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  }
}

function toPublishAccount(account: PrismaLinkedInAccount): LinkedInPublishAccount {
  return {
    ...toStoredAccount(account),
    accessToken: account.accessToken,
    tokenType: account.tokenType,
  }
}

function normalizeContentAutomationStatus(
  status: string,
): LinkedInContentAutomationStatus {
  return status === 'start' ? 'start' : 'stop'
}

function readStringArray(value: Prisma.JsonValue): string[] {
  if (Array.isArray(value)) {
    return normalizeScopeValues(
      value.flatMap((item) => readStringArray(item as Prisma.JsonValue)),
    )
  }

  if (typeof value !== 'string') {
    return []
  }

  const trimmed = value.trim()

  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    try {
      return readStringArray(JSON.parse(trimmed) as Prisma.JsonValue)
    } catch {
      return []
    }
  }

  return normalizeScopeValues(trimmed.split(','))
}

function normalizeLocale(locale: string | null) {
  if (locale === null) {
    return null
  }

  const trimmed = locale.trim()

  if (!trimmed) {
    return null
  }

  if (!trimmed.startsWith('{')) {
    return trimmed
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      country?: unknown
      language?: unknown
    }
    const language =
      typeof parsed.language === 'string' ? parsed.language.trim() : ''
    const country =
      typeof parsed.country === 'string' ? parsed.country.trim() : ''

    if (language && country) {
      return `${language}-${country}`
    }

    if (language) {
      return language
    }

    if (country) {
      return country
    }
  } catch {
    return trimmed
  }

  return trimmed
}

function normalizeScopeValues(scopes: Iterable<string>) {
  const normalized = new Set<string>()

  for (const scope of scopes) {
    const value = scope.trim()

    if (value) {
      normalized.add(value)
    }
  }

  return [...normalized]
}
