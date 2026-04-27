export async function loadLinkedInServices(env: Env) {
  const { createLinkedInServices } = await import('./create-linkedin-services')

  return createLinkedInServices(env)
}
