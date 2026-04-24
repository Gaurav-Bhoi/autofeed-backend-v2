import { serviceUnavailable } from '../../../shared/http/errors'

export function getOptionalDatabaseUrl(env: Env) {
  const databaseUrl = env.DATABASE_URL?.trim()

  if (!databaseUrl) {
    return null
  }

  try {
    return new URL(databaseUrl).toString()
  } catch {
    throw serviceUnavailable('DATABASE_URL must be a valid absolute URL')
  }
}
