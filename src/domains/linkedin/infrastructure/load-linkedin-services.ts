import { assertDependencyAvailable } from '../../../shared/dependencies/dependency-circuit-breaker'

export async function loadLinkedInServices(env: Env) {
  await assertDependencyAvailable(env, 'neon')

  const { createLinkedInServices } = await import('./create-linkedin-services')

  return createLinkedInServices(env)
}
