import type {
  LinkedInPostInput,
  LinkedInProfile,
  LinkedInPublishedPost,
  LinkedInTokenSet,
} from './linkedin.entities'

export interface LinkedInGateway {
  exchangeAuthorizationCode(code: string): Promise<LinkedInTokenSet>
  getCurrentProfile(accessToken: string): Promise<LinkedInProfile>
  createPost(
    accessToken: string,
    authorUrn: string,
    input: LinkedInPostInput,
  ): Promise<LinkedInPublishedPost>
}
