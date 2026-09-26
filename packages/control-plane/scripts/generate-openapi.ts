/**
 * `scripts/generate-openapi.ts` — emit the CP's OpenAPI 3.1 document to a file,
 * without a database or a running server.
 *
 * The spec is built purely from the routes' zod schemas at registration time
 * (see `http/plugins/openapi.ts`), so booting `buildHttpServer` with stub deps
 * and calling `app.swagger()` is enough — no repo is ever touched. This mirrors
 * how `openapi.test.ts` materializes the spec.
 *
 * Usage:
 *   tsx --conditions development scripts/generate-openapi.ts [outfile]
 *
 * `PUBLIC_CP_URL` (env) becomes the spec's `servers[0].url` — set it to the
 * host clients should call (e.g. https://api.example.test at release time).
 * `outfile` defaults to `openapi.json` in the current directory.
 *
 * `OPENAPI_PATH_PREFIX` (env) is the prefix a fronting gateway exposes the CP's
 * `/api/v1` routes under; the emitted path keys carry it, exactly as the live
 * `/openapi.json` does when the server runs with the same setting. The published
 * spec must describe the EXTERNAL contract, or a docs UI's "Try it" hits the
 * wrong URL and 404s. Unset keeps the CP's native `/api/v1` (correct for
 * direct/local access).
 *
 * Run it via the `openapi:generate` package script, which runs `prisma generate`
 * first (the client is gitignored) and passes `--conditions development` so the
 * `@agentconnect.md/protocol` workspace import resolves to source.
 */
import { writeFileSync } from 'node:fs'
import { buildHttpServer } from '../src/http/server.js'
import type { HttpDeps } from '../src/http/deps.js'
import { buildCpPlatformRegistry } from '../src/platforms/registry.js'
import { createTelegramCpProvider } from '../src/platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../src/platforms/discord/provider.js'
import { createSlackCpProvider } from '../src/platforms/slack/provider.js'
import { createFeishuCpProvider } from '../src/platforms/feishu/provider.js'

/** `config` plus the platform registry are read at spec-build time; repos stay
 *  untouched (the docs/spec routes hit no DB-backed handler). Same stub shape as
 *  `openapi.test.ts`.
 *
 *  The registry is REQUIRED, not decorative: `POST /integrations` folds each
 *  provider's `credentialBodySchema` into its documented request body when the
 *  route plugin registers (§9), so an absent registry fails `app.ready()` and a
 *  provider missing HERE is a platform missing from the PUBLISHED spec. Keep the
 *  set mirroring `container.ts`'s registration. The seams are offline stubs —
 *  no handler runs, so none of them is ever called. */
function stubDeps(): HttpDeps {
  const publicUrl = process.env.PUBLIC_CP_URL
  return {
    repos: { user: { provisionOidcUser: async () => ({ userId: 'u' }) } },
    config: {
      NODE_ENV: 'production',
      DEFAULT_OWNER_ID: '00000000-0000-4000-8000-000000000000',
      ...(publicUrl ? { PUBLIC_CP_URL: publicUrl } : {}),
      ...(process.env.OPENAPI_PATH_PREFIX ? { OPENAPI_PATH_PREFIX: process.env.OPENAPI_PATH_PREFIX } : {})
    },
    platforms: buildCpPlatformRegistry([
      createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
      createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
      createSlackCpProvider({}),
      createFeishuCpProvider({})
    ])
  } as unknown as HttpDeps
}

const outfile = process.argv[2] ?? 'openapi.json'
const app = buildHttpServer(stubDeps())
await app.ready()
const doc = app.swagger() as { openapi: string; paths: Record<string, unknown>; servers?: Array<{ url: string }> }
await app.close()

writeFileSync(outfile, JSON.stringify(doc, null, 2) + '\n')
console.log(
  `wrote ${outfile} — OpenAPI ${doc.openapi}, ${Object.keys(doc.paths).length} paths, server ${doc.servers?.[0]?.url ?? '(none)'}`
)
