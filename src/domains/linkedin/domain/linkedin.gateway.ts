import type {
  LinkedInCreatePostInput,
  LinkedInImageUploadInput,
  LinkedInProfile,
  LinkedInPublishedPost,
  LinkedInTokenSet,
  LinkedInUploadedImage,
} from './linkedin.entities'

export interface LinkedInGateway {
  exchangeAuthorizationCode(code: string): Promise<LinkedInTokenSet>
  getCurrentProfile(accessToken: string): Promise<LinkedInProfile>
  uploadImage(
    accessToken: string,
    authorUrn: string,
    input: LinkedInImageUploadInput,
  ): Promise<LinkedInUploadedImage>
  createPost(
    accessToken: string,
    authorUrn: string,
    input: LinkedInCreatePostInput,
  ): Promise<LinkedInPublishedPost>
}
