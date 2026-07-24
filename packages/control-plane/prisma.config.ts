/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Replaces the v6 `package.json#prisma` block and the CLI flags that v7 removed
 * (`--schema` on `db execute`, the implicit datasource `url`, auto-`.env`
 * loading). The runtime PrismaClient does NOT read this file — it is constructed
 * with the `@prisma/adapter-pg` driver adapter in `persistence/prisma.ts`. This
 * config is only consumed by CLI commands: `prisma migrate deploy`,
 * `prisma db execute`, `prisma db seed`, `prisma generate`.
 *
 * v7 no longer auto-loads `.env`, so we load it here for local CLI use; in
 * Docker/k8s `DATABASE_URL` is already present in the environment.
 */
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` — same entrypoint as the v6 `package.json#prisma.seed`.
    seed: 'tsx prisma/seed.ts'
  },
  datasource: {
    // Read directly (not the `env()` helper, which throws at config-load time):
    // `prisma generate` runs in CI/Docker with no DATABASE_URL, and only the
    // connection-bound commands (migrate deploy, db execute, db seed) need it.
    url: process.env.DATABASE_URL ?? ''
  }
})
