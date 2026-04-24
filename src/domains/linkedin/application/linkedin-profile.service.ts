import { badRequest } from '../../../shared/http/errors'
import type { LinkedInGateway } from '../domain/linkedin.gateway'

export class LinkedInProfileService {
  constructor(private readonly gateway: LinkedInGateway) {}

  async getCurrentProfile(accessToken: string) {
    if (!accessToken.trim()) {
      throw badRequest('LinkedIn access token is required')
    }

    return this.gateway.getCurrentProfile(accessToken)
  }
}
