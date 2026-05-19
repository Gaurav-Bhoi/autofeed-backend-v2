const DEFAULT_PENDING_JOB_TTL_SECONDS = 2 * 24 * 60 * 60
const PENDING_RUNPOD_JOB_PREFIX = 'content:scheduler:runpod:pending'

export type ScheduledRunPodPendingJob = {
  key: string
  module: string
  runpodJobId: string
  runpodStatus: string | null
  accountId: string | null
  externalAccountId: string | null
  contentKey: string | null
  createdAt: string
  updatedAt: string
}

type ScheduledRunPodPendingJobInput = {
  module: string
  runpodJobId: string
  runpodStatus?: string | null
  accountId?: string | null
  externalAccountId?: string | null
  contentKey?: string | null
}

type SchedulerStateEnv = Env & {
  CONTENT_SCHEDULER_STATE?: KVNamespace
  CONTENT_SCHEDULER_PENDING_TTL_SECONDS?: string
}

export class ContentSchedulerStateStore {
  constructor(
    private readonly state: KVNamespace | null,
    private readonly pendingJobTtlSeconds = DEFAULT_PENDING_JOB_TTL_SECONDS,
  ) {}

  get enabled() {
    return Boolean(this.state)
  }

  async listPendingRunPodJobs(moduleName: string) {
    if (!this.state) {
      return []
    }

    const listed = await this.state.list({
      prefix: createPendingRunPodJobKeyPrefix(moduleName),
      limit: 100,
    })
    const pendingJobs: ScheduledRunPodPendingJob[] = []

    for (const key of listed.keys) {
      const value = await this.state.get<unknown>(key.name, 'json')
      const pendingJob = parsePendingRunPodJob(key.name, value)

      if (pendingJob) {
        pendingJobs.push(pendingJob)
      }
    }

    return pendingJobs
  }

  async putPendingRunPodJob(input: ScheduledRunPodPendingJobInput) {
    if (!this.state) {
      return null
    }

    const now = new Date().toISOString()
    const key = createPendingRunPodJobKey(input)
    const existing = await this.state.get<ScheduledRunPodPendingJob>(
      key,
      'json',
    )
    const record: ScheduledRunPodPendingJob = {
      key,
      module: input.module,
      runpodJobId: input.runpodJobId,
      runpodStatus: input.runpodStatus ?? null,
      accountId: input.accountId ?? null,
      externalAccountId: input.externalAccountId ?? null,
      contentKey: input.contentKey ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    await this.state.put(key, JSON.stringify(record), {
      expirationTtl: this.pendingJobTtlSeconds,
    })

    return record
  }

  async deletePendingRunPodJob(key: string) {
    if (!this.state) {
      return
    }

    await this.state.delete(key)
  }
}

export function createContentSchedulerStateStore(env: Env) {
  const schedulerEnv = env as SchedulerStateEnv

  return new ContentSchedulerStateStore(
    schedulerEnv.CONTENT_SCHEDULER_STATE ?? null,
    readPositiveInteger(
      schedulerEnv.CONTENT_SCHEDULER_PENDING_TTL_SECONDS,
      DEFAULT_PENDING_JOB_TTL_SECONDS,
    ),
  )
}

function createPendingRunPodJobKey(input: ScheduledRunPodPendingJobInput) {
  const owner = input.accountId?.trim() || input.externalAccountId?.trim()
  const job = input.contentKey?.trim() || input.runpodJobId.trim()

  return [
    createPendingRunPodJobKeyPrefix(input.module),
    owner ? `${sanitizeKeyPart(owner)}:` : '',
    sanitizeKeyPart(job),
  ].join('')
}

function createPendingRunPodJobKeyPrefix(moduleName: string) {
  return `${PENDING_RUNPOD_JOB_PREFIX}:${sanitizeKeyPart(moduleName)}:`
}

function parsePendingRunPodJob(key: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const moduleName = readString(record.module)
  const runpodJobId = readString(record.runpodJobId)
  const createdAt = readString(record.createdAt)
  const updatedAt = readString(record.updatedAt)

  if (!moduleName || !runpodJobId || !createdAt || !updatedAt) {
    return null
  }

  return {
    key,
    module: moduleName,
    runpodJobId,
    runpodStatus: readString(record.runpodStatus),
    accountId: readString(record.accountId),
    externalAccountId: readString(record.externalAccountId),
    contentKey: readString(record.contentKey),
    createdAt,
    updatedAt,
  } satisfies ScheduledRunPodPendingJob
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPositiveInteger(value: string | null | undefined, fallback: number) {
  const number = Number(value)

  return Number.isInteger(number) && number > 0 ? number : fallback
}

function sanitizeKeyPart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-')
}
