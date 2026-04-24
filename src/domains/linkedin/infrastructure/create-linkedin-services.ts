import { LinkedInAuthService } from '../application/linkedin-auth.service'
import { LinkedInDashboardService } from '../application/linkedin-dashboard.service'
import { LinkedInPostService } from '../application/linkedin-post.service'
import { LinkedInProfileService } from '../application/linkedin-profile.service'
import { getLinkedInAuthConfig } from './linkedin-config'
import { getOptionalDatabaseUrl } from './linkedin-database-config'
import { LinkedInHttpGateway } from './linkedin-http.gateway'
import { PrismaLinkedInLoginRepository } from './prisma-linkedin-login.repository'
import { getPrismaClient } from '../../../shared/prisma/prisma-client'

export function createLinkedInServices(env: Env) {
  const config = getLinkedInAuthConfig(env)
  const gateway = new LinkedInHttpGateway(config)
  const databaseUrl = getOptionalDatabaseUrl(env)
  const loginRepository =
    databaseUrl === null
      ? null
      : new PrismaLinkedInLoginRepository(getPrismaClient(databaseUrl))

  return {
    authService: new LinkedInAuthService(gateway, config, loginRepository),
    dashboardService: new LinkedInDashboardService(loginRepository),
    profileService: new LinkedInProfileService(gateway),
    postService: new LinkedInPostService(gateway),
  }
}
