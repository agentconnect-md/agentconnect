import { defineConfig } from 'prisma/config'

// Generic migration-runner config. The application image exports its
// version-matched Prisma inputs into this fixed shared-volume path.
export default defineConfig({
  schema: '/migration/prisma/schema.prisma',
  migrations: {
    path: '/migration/prisma/migrations'
  },
  datasource: {
    url: process.env.DATABASE_URL ?? ''
  }
})
