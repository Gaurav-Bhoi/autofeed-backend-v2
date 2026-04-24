import { defineConfig } from 'prisma/config'

function readDatasourceUrl() {
  const directDatabaseUrl = process.env.DIRECT_DATABASE_URL?.trim()

  if (directDatabaseUrl) {
    return directDatabaseUrl
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()

  if (!databaseUrl) {
    return ''
  }

  try {
    const url = new URL(databaseUrl)

    if (url.hostname.includes('-pooler.')) {
      url.hostname = url.hostname.replace('-pooler.', '.')
    }

    return url.toString()
  } catch {
    return databaseUrl
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: readDatasourceUrl(),
  },
})
