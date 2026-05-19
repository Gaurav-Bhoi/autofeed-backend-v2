import { HTTPException } from 'hono/http-exception'

import { serviceUnavailable } from '../http/errors'

const DEPENDENCY_CIRCUIT_PREFIX = 'dependency:circuit'
const DEFAULT_NEON_BLOCK_TTL_SECONDS = 15 * 60
const DEFAULT_RUNPOD_BLOCK_TTL_SECONDS = 5 * 60

const dependencyLabels = {
  neon: 'NeonDB',
  runpod: 'RunPod',
} as const

export type DependencyName = keyof typeof dependencyLabels

export type DependencyOutage = {
  dependency: DependencyName
  reason: string
  failedAt: string
}

type DependencyCircuitBreakerEnv = Env & {
  CONTENT_SCHEDULER_STATE?: KVNamespace
  DEPENDENCY_NEON_BLOCK_TTL_SECONDS?: string
  DEPENDENCY_RUNPOD_BLOCK_TTL_SECONDS?: string
  DEPENDENCY_NEON_FORCE_DOWN?: string
  DEPENDENCY_NEON_FORCE_DOWN_REASON?: string
  DEPENDENCY_RUNPOD_FORCE_DOWN?: string
  DEPENDENCY_RUNPOD_FORCE_DOWN_REASON?: string
}

export class DependencyCircuitBreaker {
  constructor(
    private readonly state: KVNamespace | null,
    private readonly blockTtlSeconds: Record<DependencyName, number>,
    private readonly forcedOutages: Record<DependencyName, DependencyOutage | null>,
  ) {}

  get enabled() {
    return Boolean(this.state)
  }

  async readOutage(dependency: DependencyName) {
    const forcedOutage = this.forcedOutages[dependency]

    if (forcedOutage) {
      return forcedOutage
    }

    if (!this.state) {
      return null
    }

    const value = await this.state.get<unknown>(
      createDependencyCircuitKey(dependency),
      'json',
    )

    return parseDependencyOutage(dependency, value)
  }

  async assertAvailable(dependency: DependencyName) {
    const outage = await this.readOutage(dependency)

    if (!outage) {
      return
    }

    throw createDependencyCircuitOpenError(outage)
  }

  async recordFailure(dependency: DependencyName, error: unknown) {
    if (!this.state || isDependencyCircuitOpenError(error)) {
      return
    }

    const outage: DependencyOutage = {
      dependency,
      reason: readErrorMessage(error),
      failedAt: new Date().toISOString(),
    }

    await this.state.put(
      createDependencyCircuitKey(dependency),
      JSON.stringify(outage),
      {
        expirationTtl: this.blockTtlSeconds[dependency],
      },
    )
  }

  async recordSuccess(dependency: DependencyName) {
    if (!this.state) {
      return
    }

    await this.state.delete(createDependencyCircuitKey(dependency))
  }
}

export function createDependencyCircuitBreaker(env: Env) {
  const dependencyEnv = env as DependencyCircuitBreakerEnv

  return new DependencyCircuitBreaker(
    dependencyEnv.CONTENT_SCHEDULER_STATE ?? null,
    {
      neon: readDependencyBlockTtlSeconds('neon', dependencyEnv),
      runpod: readDependencyBlockTtlSeconds('runpod', dependencyEnv),
    },
    {
      neon: readForcedDependencyOutage('neon', dependencyEnv),
      runpod: readForcedDependencyOutage('runpod', dependencyEnv),
    },
  )
}

export async function assertDependencyAvailable(
  env: Env,
  dependency: DependencyName,
) {
  await createDependencyCircuitBreaker(env).assertAvailable(dependency)
}

export async function recordDependencyFailure(
  env: Env,
  dependency: DependencyName,
  error: unknown,
) {
  await createDependencyCircuitBreaker(env).recordFailure(dependency, error)
}

export async function recordDependencySuccess(
  env: Env,
  dependency: DependencyName,
) {
  await createDependencyCircuitBreaker(env).recordSuccess(dependency)
}

export async function recordKnownDependencyFailure(env: Env, error: unknown) {
  const circuitBreaker = createDependencyCircuitBreaker(env)
  const writes: Promise<void>[] = []

  if (isNeonUnavailableError(error)) {
    writes.push(circuitBreaker.recordFailure('neon', error))
  }

  if (isRunPodUnavailableError(error)) {
    writes.push(circuitBreaker.recordFailure('runpod', error))
  }

  await Promise.all(writes)
}

export function isNeonUnavailableError(error: unknown) {
  if (isDependencyCircuitOpenError(error)) {
    return false
  }

  const message = readErrorMessage(error).toLowerCase()
  const name =
    error instanceof Error && error.name ? error.name.toLowerCase() : ''
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code).toLowerCase()
      : ''

  if (
    name.includes('prisma') ||
    code.startsWith('p10') ||
    code === '57p01' ||
    code === '08006'
  ) {
    return true
  }

  return [
    'database unavailable',
    'database_url',
    'neon',
    'compute allowance',
    'limit reached',
    'connection terminated',
    'connection refused',
    'connection reset',
    'connection timed out',
    'error connecting to database',
    "can't reach database server",
    'too many connections',
  ].some((needle) => message.includes(needle))
}

export function isRunPodUnavailableError(error: unknown) {
  if (isDependencyCircuitOpenError(error)) {
    return false
  }

  const message = readErrorMessage(error).toLowerCase()

  return [
    'runpod unavailable',
    'runpod job submission failed',
    'runpod status request failed',
    'runpod job cancellation failed',
    'api.runpod.ai',
  ].some((needle) => message.includes(needle))
}

export function isDependencyCircuitOpenError(error: unknown) {
  return (
    error instanceof HTTPException &&
    error.status === 503 &&
    error.message.startsWith('Dependency unavailable:')
  )
}

function createDependencyCircuitOpenError(outage: DependencyOutage) {
  const label = dependencyLabels[outage.dependency]

  return serviceUnavailable(
    `Dependency unavailable: ${label} is currently marked down; skipping downstream calls until the circuit TTL expires. Last failure: ${outage.reason}`,
  )
}

function parseDependencyOutage(
  dependency: DependencyName,
  value: unknown,
): DependencyOutage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const recordDependency = readDependencyName(record.dependency)
  const reason = readString(record.reason)
  const failedAt = readString(record.failedAt)

  if (recordDependency !== dependency || !reason || !failedAt) {
    return null
  }

  return {
    dependency,
    reason,
    failedAt,
  }
}

function createDependencyCircuitKey(dependency: DependencyName) {
  return `${DEPENDENCY_CIRCUIT_PREFIX}:${dependency}`
}

function readDependencyBlockTtlSeconds(
  dependency: DependencyName,
  env: DependencyCircuitBreakerEnv,
) {
  if (dependency === 'neon') {
    return readPositiveInteger(
      env.DEPENDENCY_NEON_BLOCK_TTL_SECONDS,
      DEFAULT_NEON_BLOCK_TTL_SECONDS,
    )
  }

  return readPositiveInteger(
    env.DEPENDENCY_RUNPOD_BLOCK_TTL_SECONDS,
    DEFAULT_RUNPOD_BLOCK_TTL_SECONDS,
  )
}

function readForcedDependencyOutage(
  dependency: DependencyName,
  env: DependencyCircuitBreakerEnv,
): DependencyOutage | null {
  const forceDown =
    dependency === 'neon'
      ? env.DEPENDENCY_NEON_FORCE_DOWN
      : env.DEPENDENCY_RUNPOD_FORCE_DOWN

  if (!readBoolean(forceDown)) {
    return null
  }

  const reason =
    dependency === 'neon'
      ? env.DEPENDENCY_NEON_FORCE_DOWN_REASON
      : env.DEPENDENCY_RUNPOD_FORCE_DOWN_REASON

  return {
    dependency,
    reason:
      reason?.trim() ||
      `${dependencyLabels[dependency]} is manually marked down by environment`,
    failedAt: new Date().toISOString(),
  }
}

function readDependencyName(value: unknown): DependencyName | null {
  return value === 'neon' || value === 'runpod' ? value : null
}

function readBoolean(value: string | null | undefined) {
  return ['1', 'true', 'yes', 'on', 'down'].includes(
    value?.trim().toLowerCase() ?? '',
  )
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPositiveInteger(value: string | null | undefined, fallback: number) {
  const number = Number(value)

  return Number.isInteger(number) && number > 0 ? number : fallback
}

function readErrorMessage(error: unknown) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Dependency request failed'

  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 500)
}
