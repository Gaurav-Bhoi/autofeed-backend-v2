import { PrismaNeon } from '@prisma/adapter-neon'

import { PrismaClient } from '../../generated/prisma/client'

export function getPrismaClient(databaseUrl: string) {
  const adapter = new PrismaNeon({
    connectionString: databaseUrl,
  })

  return new PrismaClient({
    adapter,
  })
}
