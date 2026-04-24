import { createApp } from './app/create-app'

const app = createApp()

export { app }
export type AppType = typeof app

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
