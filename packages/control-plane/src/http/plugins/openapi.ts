/**
 * `http/plugins/openapi.ts` — generates an OpenAPI 3.1 document from the zod
 * route schemas the C2 BFF already declares (via `fastify-type-provider-zod`)
 * and serves interactive docs, so the public REST surface is self-documenting.
 *
 * How it works: `@fastify/swagger` hooks `onRoute` and, for each route, runs the
 * `createJsonSchemaTransform` transform to turn that route's zod
 * params/body/querystring/response schemas into JSON Schema and fold them into
 * the spec. Nothing per-route changes — the DTOs in `http/dto/` ARE the spec.
 *
 * Mounting:
 *   - `GET /docs`               — Swagger-UI (interactive explorer)
 *   - `GET /api/v1/openapi.json` — the raw OpenAPI document (for codegen/CI)
 *
 * The interactive UI sits at the ROOT (`/docs`), unversioned — it is human
 * tooling, not part of the public REST contract (same rationale as `/health`);
 * a single-segment mount also sidesteps the sub-path asset-resolution quirks
 * that dog UIs served under a deep prefix. The machine-readable artifact — the
 * thing clients actually version against — stays under the versioned tree at
 * `/api/v1/openapi.json`.
 *
 * Kept OUT of the generated spec (not part of the public REST contract — see
 * `version.ts`): `GET /health` (infra probe) and the `/daemon/ws` control
 * channel (protocol-versioned in-band; not an HTTP route on this server). Health
 * is dropped via the `skipList`; the WS endpoint never registers as a route
 * here. The Swagger-UI's own asset routes are skipped too.
 *
 * OpenAPI 3.1 (not Swagger 2.0 / OpenAPI 3.0): zod v4 emits JSON Schema in the
 * draft-2020-12 dialect, of which OpenAPI 3.1 is a superset — so the DTOs
 * round-trip cleanly. The `info.version` ("1") is the API version and is
 * independent of the OpenAPI spec version.
 *
 * Registration order matters: install this BEFORE the route plugins in
 * `buildHttpServer`, so `@fastify/swagger`'s `onRoute` hook is in place when the
 * documented routes register.
 */
import type { FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import type { SwaggerTransformObject } from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { createJsonSchemaTransform } from 'fastify-type-provider-zod'
import { API_V1_PREFIX } from '../version.js'

/** Interactive Swagger-UI mount point — root, unversioned (human tooling). */
export const DOCS_PATH = '/docs'
/** Canonical raw-spec path (stable URL for client codegen / CI diffing). */
export const OPENAPI_JSON_PATH = `${API_V1_PREFIX}/openapi.json`

/**
 * Sidebar groups — OpenAPI operation `tags`. Exported so each route schema
 * references the *same* string (a typo would silently spawn a duplicate group).
 * A route with no tag lands under a nameless "default" group, so every
 * documented operation should carry exactly one of these.
 */
export const Tag = {
  Deployment: 'Deployment',
  Organizations: 'Organizations',
  Profile: 'Profile',
  Members: 'Members',
  Daemons: 'Daemons',
  MemberSets: 'Member sets',
  DaemonKeys: 'Daemon keys',
  ApiKeys: 'API keys',
  Agents: 'Agents',
  Workspace: 'Agent workspace',
  Sessions: 'Sessions',
  Integrations: 'Integrations',
  Bots: 'Bots',
  Mcp: 'MCP providers',
  Skills: 'Skill sources',
  Knowledge: 'Organization knowledge',
  Environment: 'Organization variables & secrets',
  Memory: 'External memory',
  Crons: 'Crons',
  Hooks: 'Hooks',
  Usage: 'Usage',
  Stream: 'Stream',
  GitHub: 'GitHub',
  GitLab: 'GitLab'
} as const

/** Group order + blurbs for the docs sidebar (OpenAPI top-level `tags`). */
const TAG_DESCRIPTIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: Tag.Deployment, description: 'Secret-free runtime metadata for deployment clients.' },
  { name: Tag.Organizations, description: 'The caller’s organizations — list, create, rename, delete.' },
  { name: Tag.Profile, description: 'The signed-in user’s own profile.' },
  { name: Tag.Members, description: 'Organization membership and roles.' },
  {
    name: Tag.Daemons,
    description: 'Edge daemons — the message + agent-execution units. Enrollment tokens and lifecycle.'
  },
  {
    name: Tag.MemberSets,
    description: 'Named sets of daemons an agent’s duty may be claimed within — the failover unit.'
  },
  { name: Tag.DaemonKeys, description: 'A daemon’s API keys (issue, list, revoke).' },
  { name: Tag.ApiKeys, description: 'Your personal API keys — create, list, revoke.' },
  { name: Tag.Agents, description: 'Agent definitions — CRUD and connect/launch.' },
  { name: Tag.Workspace, description: 'Read an agent’s daemon-local workspace (files, git status/pull).' },
  { name: Tag.Sessions, description: 'Conversation sessions and their message history.' },
  { name: Tag.Integrations, description: 'IM-platform integrations (Slack / Telegram / Discord) and their channels.' },
  { name: Tag.Bots, description: 'Durable platform bot identities.' },
  {
    name: Tag.Mcp,
    description: 'Org-level MCP providers — upstream tool servers the CP proxies through a relay to agents.'
  },
  {
    name: Tag.Skills,
    description:
      'Org-level public GitHub skill sources — metadata the daemon binds to a numeric repository identity, acquires as a bounded snapshot, and installs with its bundled exact CLI.'
  },
  {
    name: Tag.Knowledge,
    description: 'Accepted organization knowledge, managed Agent Skills bundles, and Dream suggestions.'
  },
  {
    name: Tag.Environment,
    description:
      'Organization-owned environment variables and secrets, defined once and assigned to all or selected agents. Owner-only. Secret values are write-only — accepted on create/replace and never returned.'
  },
  {
    name: Tag.Memory,
    description: 'Owner-reviewed external-memory plugin installations and org connections.'
  },
  { name: Tag.Crons, description: 'Scheduled agent runs.' },
  {
    name: Tag.Hooks,
    description: 'Inbound-webhook triggers — an external POST to a relay ingress URL fires an agent turn.'
  },
  { name: Tag.Usage, description: 'Token-usage reporting.' },
  { name: Tag.Stream, description: 'Server-sent event stream for live console updates.' },
  {
    name: Tag.GitHub,
    description: 'GitHub App installations powering github-app workspaces (repo picker + short-lived git credentials).'
  },
  {
    name: Tag.GitLab,
    description: 'GitLab.com OAuth connections — the administration identity for project discovery and provisioning.'
  }
]

export interface OpenapiOptions {
  /** Externally-reachable CP origin (`PUBLIC_CP_URL`); emitted as the spec's
   *  `servers[0].url` so "Try it out" targets the real host. Omitted when unset. */
  publicUrl?: string
}

/**
 * Paths the spec must not list: `/health` (not public REST) plus the routes the
 * Swagger-UI and the raw-spec endpoint register themselves — documenting the
 * docs is noise. Mirrors `fastify-type-provider-zod`'s default skip entries,
 * re-pointed at our `DOCS_PATH` (the default assumes `/documentation`).
 */
const SKIP_LIST = [
  '/health',
  `${DOCS_PATH}/`,
  `${DOCS_PATH}/initOAuth`,
  `${DOCS_PATH}/json`,
  `${DOCS_PATH}/uiConfig`,
  `${DOCS_PATH}/yaml`,
  `${DOCS_PATH}/*`,
  `${DOCS_PATH}/static/*`,
  OPENAPI_JSON_PATH
]

/** HTTP methods a path-item may key an Operation Object under (OpenAPI 3.1). */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/**
 * Backfill path parameters that Fastify **prefix** segments contribute but the
 * per-route zod schema never declares.
 *
 * Every resource is mounted under the `/orgs/:orgId` prefix, yet a leaf route
 * (`GET /agents/:id`) only puts `id` in its `schema.params` — `orgId` is read
 * from the raw params by the org-scope guard, deliberately outside the schema
 * (see `server.ts`). `fastify-type-provider-zod` derives an operation's path
 * parameters *solely* from `schema.params`, so it emits `id` but not `orgId`,
 * leaving `{orgId}` in the path template with no matching parameter. That is an
 * OpenAPI 3.1 violation ("missing path parameter(s) for `{orgId}`") that fails
 * spec validators / rich-diff renderers, even though the UI still loads.
 * (Collection routes escape it: with no `schema.params` at all, the zod
 * transform falls back to auto-deriving every `{token}` from the URL.)
 *
 * Fix centrally, once, at render time: for each path, ensure every `{token}` in
 * the path template has an `in: path` parameter on each operation, synthesizing
 * a `required` string parameter for any that is missing. Runs on every
 * `app.swagger()` materialization, so `/docs/json` and `/openapi.json` agree.
 */
const backfillPrefixPathParams: SwaggerTransformObject = (doc) => {
  type Param = { name?: string; in?: string }
  type Operation = { parameters?: Param[] }
  const openapiObject = 'openapiObject' in doc ? doc.openapiObject : doc.swaggerObject
  for (const [path, item] of Object.entries(openapiObject.paths ?? {})) {
    const tokens = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
    if (tokens.length === 0 || !item) continue
    const pathItem = item as Record<string, unknown>
    // Path-item-level params (if any) already cover every operation.
    const sharedNames = new Set(((pathItem.parameters as Param[] | undefined) ?? []).map((p) => p.name))
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as Operation | undefined
      if (!op) continue
      const present = new Set([...sharedNames, ...(op.parameters ?? []).map((p) => p.name)])
      const missing = tokens.filter((t) => !present.has(t))
      if (missing.length === 0) continue
      // Emit in path order — prefix params first — for a readable spec.
      op.parameters = [
        ...missing.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        ...(op.parameters ?? [])
      ]
    }
  }
  return openapiObject
}

/**
 * Install OpenAPI generation + interactive docs on `app`. Call once on the root
 * instance, after `installZod` and BEFORE the route plugins register.
 */
export function installOpenapi(app: FastifyInstance, opts: OpenapiOptions = {}): void {
  void app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AgentConnect API',
        description:
          'The C2 BFF REST surface (Web UI ⇄ Control Plane). Every resource is ' +
          'org-scoped under `/api/v1/orgs/:orgId` behind bearer auth; a ' +
          'cross-org id reads as 404. The Control Plane stores only control-plane ' +
          'metadata — message bodies and workspace bytes stay daemon-local.',
        version: '1'
      },
      ...(opts.publicUrl ? { servers: [{ url: opts.publicUrl }] } : {}),
      components: {
        securitySchemes: {
          // Human-auth plane: a bearer JWT (OIDC) when `OIDC_ISSUER` is set; the
          // devAuth stub admits all when it is not. Documented as bearer either way.
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
        }
      },
      // Default requirement for the whole surface; individual routes may still
      // relax it in their own schema. Descriptive only — not enforced by the spec.
      security: [{ bearerAuth: [] }],
      // Sidebar groups (ordered) + their blurbs. Operations reference these by
      // name via `Tag.*`; an operation with no tag falls into a nameless group.
      tags: [...TAG_DESCRIPTIONS]
    },
    transform: createJsonSchemaTransform({ skipList: SKIP_LIST }),
    // Backfill prefix path params (`{orgId}`) the per-route zod schemas omit —
    // otherwise the spec fails OpenAPI 3.1 validation. See the helper above.
    transformObject: backfillPrefixPathParams
  })

  void app.register(fastifySwaggerUi, {
    routePrefix: DOCS_PATH,
    uiConfig: { docExpansion: 'list', deepLinking: true }
  })

  // Canonical raw-spec endpoint. `app.swagger()` is added by `@fastify/swagger`
  // and materializes the document on demand. `hide` keeps it out of the spec.
  app.get(OPENAPI_JSON_PATH, { schema: { hide: true } }, async () => app.swagger())
}
