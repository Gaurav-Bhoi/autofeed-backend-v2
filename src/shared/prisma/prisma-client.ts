import { PrismaNeon } from '@prisma/adapter-neon'

import { PrismaClient } from '../../generated/prisma/client'

const prismaClients = new Map<string, PrismaClient>()

export function getPrismaClient(databaseUrl: string) {
  let prisma = prismaClients.get(databaseUrl)

  if (!prisma) {
    const adapter = new PrismaNeon({
      connectionString: databaseUrl,
    })

    prisma = new PrismaClient({
      adapter,
    })
    prismaClients.set(databaseUrl, prisma)
  }

  return prisma
}
