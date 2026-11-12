// Connecting a Microsoft 365 tenant to the deployment's Teams app from the Console (teams-integration.md §8.3).
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MSTEAMS_PLATFORM, MSTEAMS_RELAY_EGRESS_V1_FEATURE } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import { ErrorDto, IdParam } from '../../http/dto/index.js'
import { ctxOf, denyViewerWrite, orgOf } from '../../http/rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { integrationPlatformAvailability } from '../../http/daemon-platform-capability.js'
import { installNewBot } from '../../http/install-bot.js'
import { relayHttpBase, relayIngress } from '../../http/relay-ingress.js'
import { agentIconBackgroundColor } from '../../agents/agent-icon.js'
import { AgentId, DaemonId, IntegrationId } from '../../domain/ids.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import type { AgentRecord, MsTeamsAgentBotRequestRecord, MsTeamsBindingMutations } from '../../persistence/ports.js'
import {
  MSTEAMS_REQUEST_FIRST_CHECK_MS,
  MsTeamsRequestBusy,
  type MsTeamsAgentBotRequests
} from './agent-bot-requests.js'
import {
  MsTeamsAgentBotClient,
  MsTeamsAgentBotError,
  msTeamsAgentBotKey,
  msTeamsAgentBotResourceName
} from './agent-bots.js'
import {
  MsTeamsRecoveryError,
  msTeamsRecoveryChanged,
  msTeamsRecoveryRows,
  msTeamsRecoverySnapshot,
  type MsTeamsRecoveryOAuth
} from './recovery.js'
import {
  MSTEAMS_RSC_PERMISSIONS,
  msTeamsAppIcons,
  msTeamsAppName,
  msTeamsAppPackage,
  msTeamsManifest,
  msTeamsPackageFingerprint,
  msTeamsPackageId
} from './app-package.js'
import {
  MsTeamsConnectError,
  installMsTeamsApp,
  listMsTeamsTeams,
  mintMsTeamsConnectState,
  msTeamsAdminConsentUrl,
  msTeamsAuthorizeUrl,
  openMsTeamsTicket,
  publishMsTeamsPackage,
  readMsTeamsOrganizationName,
  redeemMsTeamsCode,
  sealMsTeamsTicket,
  submitMsTeamsPackage,
  upgradeMsTeamsInstalls,
  verifyMsTeamsConnectState,
  type MsTeamsConnectKeys,
  installMsTeamsAppForUserEventually,
  readMsTeamsUsername
} from './connect.js'
import {
  MSTEAMS_DEPLOYMENT_OWNER,
  MSTEAMS_ROW_OWNER_KEY,
  MSTEAMS_TENANT_CONSENT_KEY,
  MSTEAMS_TENANT_CONSENT_VERSION,
  isMsTeamsDeploymentRow,
  msTeamsAgentBotEntries,
  msTeamsAgentBotOf,
  msTeamsDeploymentSecrets,
  type MsTeamsAgentBots,
  type MsTeamsPlatformApp
} from './deployment-app.js'

export interface MsTeamsConnectSeams {
  /** The deployment-owned app; absent ⇒ every route answers that there is none. */
  app?: MsTeamsPlatformApp
  /** The blueprint and the Azure resource group agent bots are made with (§8.6.3); absent ⇒ a tenant serves one agent. */
  agentBots?: MsTeamsAgentBots
  /** The wait between tries while a new principal or identity settles; tests pass one that does not sleep. */
  agentBotWait?: (ms: number) => Promise<void>
  /** The wait between tries of adding a new app for the person who connected it; tests pass one that does not sleep. */
  personalInstallWait?: (ms: number) => Promise<void>
  /** Members' pending requests (§8.6.6), built with the same app and blueprint; absent ⇒ no member flow. */
  requests?: MsTeamsAgentBotRequests
  keys: MsTeamsConnectKeys
  bindingMutations: MsTeamsBindingMutations
  recovery?: MsTeamsRecoveryOAuth
  /** The Console origin whose `/msteams/connect` page Microsoft redirects to. */
  webAppUrl?: string
  fetch?: typeof fetch
}

// A wait that does not hold the process open on shutdown.
const sleepUnref = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref())

/** The Console page the deployment app's registration lists as a Web redirect URI. */
export function msTeamsConnectRedirectUri(webAppUrl: string): string {
  return `${webAppUrl.replace(/\/+$/, '')}/msteams/connect`
}

const TAKEN_MESSAGE =
  'This Microsoft 365 organization is already connected to another AgentConnect organization. A Teams or Global Administrator can recover the connection here, or contact support.'
const IN_USE_MESSAGE =
  'This Microsoft 365 organization already connects another agent here. Remove that Teams integration first, or register your own bot for this agent.'

const NAME_TAKEN_MESSAGE = (holder: string) =>
  `Another agent of this Microsoft 365 organization, ${holder}, already appears in Teams under this name. Rename one of them first, so people can tell them apart.`
const AGENT_BOTS_UNAVAILABLE_MESSAGE = (reason: string) =>
  `Microsoft did not let this deployment create a bot for this agent in your Microsoft 365 organization (${reason}). Agents already connected are unaffected.`
const CONSENT_NEEDED_MESSAGE =
  'An administrator of this Microsoft 365 organization has to approve the app for the organization first.'
const NOT_CONNECTED_MESSAGE =
  'Your Microsoft 365 organization is not connected here yet. A Teams or Global administrator has to connect it first.'
const ALREADY_CONNECTED_MESSAGE =
  'This agent is already in Teams for your Microsoft 365 organization. A Teams administrator updates it from the agent’s Teams bot.'

const MsTeamsDeploymentAppDto = z.object({
  appId: z
    .string()
    .nullable()
    .describe('The deployment Teams app’s Entra application ID; null when the deployment has no app to connect to.')
})
const ConnectBody = z.object({
  agentId: z.uuid().describe('The agent the Teams app will serve.'),
  tenantId: z
    .uuid()
    .optional()
    .describe(
      'The tenant a Teams Store install named on its Connect card: the sign-in must be of it, asks only to read the profile, and publishes and installs nothing.'
    ),
  consent: z
    .boolean()
    .optional()
    .describe(
      'True to ask the tenant-wide consent even where a tenant of the organization recorded it: the connect page sends it after a sign-in of another tenant answered 409 MSTEAMS_CONSENT_NEEDED.'
    )
})
const RequestDto = z.object({
  id: z.string(),
  agentId: z.string(),
  tenantId: z.string(),
  status: z
    .enum(['pending', 'needs_sign_in', 'rejected'])
    .describe(
      'pending: waiting for a Teams administrator to approve the package; needs_sign_in: the stored sign-in stopped working, so the member signs in again; rejected: the package was turned down or removed.'
    ),
  reason: z.string().nullable(),
  createdAt: z.string(),
  adminCenterUrl: z
    .string()
    .describe('The package’s own page in the Teams admin center, where a Teams administrator publishes it.')
})
/** Teams apps → Manage apps, where each catalog app has a page with its Publish action. */
const MSTEAMS_ADMIN_CENTER_URL = 'https://admin.teams.microsoft.com/policies/manage-apps'
const requestDto = (request: MsTeamsAgentBotRequestRecord): z.infer<typeof RequestDto> => ({
  id: request.id,
  agentId: request.agentId,
  tenantId: request.tenantId,
  status: request.status,
  reason: request.reason,
  createdAt: request.createdAt.toISOString(),
  adminCenterUrl: `${MSTEAMS_ADMIN_CENTER_URL}/${encodeURIComponent(request.catalogAppId)}`
})
const ConnectDto = z.object({ authorizeUrl: z.url().describe('Microsoft’s sign-in page to send the browser to.') })
const ConsentedBody = z.object({
  state: z.string().min(1).max(2048).describe('The state Microsoft returned to the connect page with the consent.')
})
const CallbackBody = z.object({
  code: z.string().min(1).max(4096).describe('The authorization code Microsoft returned to the connect page.'),
  state: z.string().min(1).max(2048).describe('The state Microsoft returned with it.')
})
const ConflictDto = ErrorDto.extend({ recovery: z.object({ tenantId: z.string(), agentId: z.string() }).optional() })
const CallbackDto = z.object({
  integrationId: z
    .string()
    .optional()
    .describe('The agent’s Teams integration; absent while its own bot is still to be created.'),
  agentId: z.string(),
  agentBot: z
    .boolean()
    .optional()
    .describe(
      'True when the tenant already serves another agent, so this agent gets a bot of its own: the ticket goes to the agent-bot step, which answers the integration and the ticket for the install step.'
    ),
  request: RequestDto.optional().describe(
    'The agent’s request waiting for a Teams administrator: one the agent-bot step just made because the signed-in person may not publish, or an open one this sign-in renewed.'
  ),
  authorizeUrl: z
    .url()
    .optional()
    .describe(
      'Present alone when the person signed in at another tenant than the one this organization connected: a silent sign-in at that tenant, which succeeds for its guests and otherwise returns an error the connect page answers by starting again through the consent.'
    ),
  teams: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        app: z
          .enum(['updated', 'none', 'failed'])
          .describe(
            'The app in this team: updated to the published package, not installed, or not updated because Microsoft refused or failed the read or upgrade; the package stays pending until no team fails.'
          )
      })
    )
    .describe('The signed-in administrator’s teams; empty for a Teams Store install.'),
  ticket: z
    .string()
    .optional()
    .describe('An opaque, short-lived handle for the install step; absent for a Teams Store install.'),
  store: z
    .boolean()
    .describe('Whether the tenant installed the app from the Teams Store, so nothing was published or installed.')
})
const AgentBotBody = z.object({ ticket: z.string().min(1).max(16_384) })
const InstallBody = z.object({
  ticket: z.string().min(1).max(16_384),
  teamIds: z.array(z.string().min(1).max(256)).min(1).max(50)
})
const InstallDto = z.object({ installed: z.number().int().describe('How many teams now have the app.') })

function refuse(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const label = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 502: 'Bad Gateway' }
  return reply
    .code(status)
    .send({ error: label[status as keyof typeof label] ?? 'Error', statusCode: status, code, message })
}

const STATUS_OF: Record<MsTeamsConnectError['code'], number> = {
  MSTEAMS_CONNECT_DENIED: 400,
  MSTEAMS_CONNECT_PERSONAL_ACCOUNT: 400,
  MSTEAMS_CONNECT_NOT_ADMIN: 403,
  MSTEAMS_CONNECT_UNAVAILABLE: 502,
  MSTEAMS_TENANT_MISMATCH: 400
}

// A refusal from Microsoft is answered by its code, and logged with the call that failed, which the answer does not carry.
function refuseConnect(req: FastifyRequest, reply: FastifyReply, err: MsTeamsConnectError): FastifyReply {
  req.log.warn({ code: err.code, detail: err.detail }, 'msteams: connect step refused by Microsoft')
  return refuse(reply, STATUS_OF[err.code], err.code, err.message)
}

// The agent the tenant will serve, once the caller may edit it and its daemon runs Teams.
export async function connectTarget(
  deps: HttpDeps,
  req: FastifyRequest,
  agentId: string
): Promise<AgentRecord | string> {
  const agent = await deps.repos.agent.get(orgOf(req), AgentId(agentId))
  if (!agent || !canView(agent, ctxOf(req))) return 'agent not found'
  if (!canEdit(agent, ctxOf(req))) return 'cannot edit this agent'
  const servingDaemonId = await deps.placementResolver.servingDaemon(agent)
  if (servingDaemonId) {
    const availability = await integrationPlatformAvailability(deps, {
      daemonId: servingDaemonId,
      orgId: orgOf(req),
      viewer: ctxOf(req),
      platform: MSTEAMS_PLATFORM
    })
    if (availability === 'not_found') return 'daemon not found'
    if (availability === 'unsupported') return `daemon does not support ${MSTEAMS_PLATFORM} integrations`
    // An older daemon could only send with the app's secret, which no daemon receives (§8.5).
    const daemon = await deps.registry.getAvailable(orgOf(req), DaemonId(servingDaemonId))
    if (!daemon?.capabilities.features.includes(MSTEAMS_RELAY_EGRESS_V1_FEATURE))
      return 'upgrade the agent’s daemon: this Teams app sends through the relay, which its version does not support'
  }
  return agent
}

// The agent that already appears in this tenant under the name the target's package would take (§8.6.4); Teams lists every bot of a tenant in one mention picker.
async function nameHolder(
  deps: HttpDeps,
  orgId: AgentRecord['orgId'],
  tenantId: string,
  target: AgentRecord
): Promise<string | undefined> {
  const label = deps.config.MSTEAMS_APP_LABEL
  const nameOf = (agent: AgentRecord) => msTeamsAppName(agent.displayName ?? agent.name, label, 30).toLowerCase()
  const wanted = nameOf(target)
  for (const bot of await deps.repos.bot.listForOrg(orgId)) {
    if (bot.platform !== MSTEAMS_PLATFORM || bot.externalTenantId !== tenantId || !isMsTeamsDeploymentRow(bot)) continue
    for (const agentId of bot.agentIds) {
      if (agentId === target.id) continue
      const other = await deps.repos.agent.get(orgId, agentId)
      if (other && nameOf(other) === wanted) return other.displayName ?? other.name
    }
  }
  return undefined
}

export function msTeamsConnectRoutes(deps: HttpDeps, seams: MsTeamsConnectSeams) {
  const fetchImpl: typeof fetch = (input, init) => (seams.fetch ?? fetch)(input, init)
  const usable = () => (seams.app && seams.webAppUrl ? { app: seams.app, webAppUrl: seams.webAppUrl } : undefined)
  const agentBotClient =
    seams.app && seams.agentBots
      ? new MsTeamsAgentBotClient({
          app: seams.app,
          agentBots: seams.agentBots,
          fetch: fetchImpl,
          ...(seams.agentBotWait ? { wait: seams.agentBotWait } : {})
        })
      : undefined
  return async function msTeamsConnectRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/integrations/msteams/app',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Read the deployment Teams app',
          description:
            'The public identity of the Teams app this deployment operates, which an organization connects its Microsoft 365 tenant to instead of registering its own bot. Never returns its secret.',
          operationId: 'getMsTeamsDeploymentApp',
          response: { 200: MsTeamsDeploymentAppDto }
        }
      },
      async () => ({ appId: usable()?.app.appId ?? null })
    )

    r.post(
      '/integrations/msteams/connect',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Start connecting a Microsoft 365 tenant',
          description:
            'Answer Microsoft’s sign-in URL for the deployment Teams app. An administrator of the tenant signs in and consents to publishing the app to the organization catalog, listing their teams, and installing the app with its resource-specific permissions; Microsoft then returns to the Console’s connect page. The state is signed for this organization, agent and caller and expires in ten minutes.',
          operationId: 'startMsTeamsConnect',
          body: ConnectBody,
          response: { 200: ConnectDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const target = await connectTarget(deps, req, req.body.agentId)
        if (typeof target === 'string') return refuse(reply, 409, 'MSTEAMS_CONNECT_NO_AGENT', target)
        const tenant = req.body.tenantId?.toLowerCase()
        // With agent bots an administrator connect asks the tenant-wide consent first (§8.6.5), once: an organization whose tenant recorded it signs in directly. A Store install only proves its tenant.
        const agentBots = Boolean(agentBotClient) && !tenant
        const recorded =
          agentBots &&
          !req.body.consent &&
          (await deps.repos.bot.listForOrg(orgOf(req))).some(
            (row) =>
              row.platform === MSTEAMS_PLATFORM &&
              row.platformConfig?.[MSTEAMS_TENANT_CONSENT_KEY] === MSTEAMS_TENANT_CONSENT_VERSION
          )
        const consent = agentBots && !recorded
        const state = mintMsTeamsConnectState(
          seams.keys,
          {
            orgId: orgOf(req),
            agentId: target.id,
            userId: req.principal.userId,
            ...(tenant ? { tenant } : {}),
            ...(agentBots ? { agentBots: true } : {}),
            ...(consent ? { consent: true } : {})
          },
          deps.clock
        )
        const redirectUri = msTeamsConnectRedirectUri(live.webAppUrl)
        return {
          authorizeUrl: consent
            ? msTeamsAdminConsentUrl({ clientId: live.app.appId, redirectUri, state })
            : msTeamsAuthorizeUrl(seams.keys, {
                clientId: live.app.appId,
                redirectUri,
                state,
                ...(tenant ? { tenant } : {}),
                ...(agentBots ? { agentBots: true } : {})
              })
        }
      }
    )

    r.post(
      '/integrations/msteams/connect/consented',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Continue connecting after the tenant-wide consent',
          description:
            'After an administrator accepted the tenant-wide consent, Microsoft returns to the Console’s connect page with the state and no code. This answers the sign-in URL that follows, for the same organization, agent and caller, with a new state that expires in ten minutes.',
          operationId: 'continueMsTeamsConnect',
          body: ConsentedBody,
          response: { 200: ConnectDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const consented = verifyMsTeamsConnectState(seams.keys, req.body.state, deps.clock)
        if (!consented?.consent || consented.orgId !== orgOf(req) || consented.userId !== req.principal.userId) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        const state = mintMsTeamsConnectState(
          seams.keys,
          {
            orgId: consented.orgId,
            agentId: consented.agentId,
            userId: consented.userId,
            agentBots: true,
            consented: true
          },
          deps.clock
        )
        return {
          authorizeUrl: msTeamsAuthorizeUrl(seams.keys, {
            clientId: live.app.appId,
            redirectUri: msTeamsConnectRedirectUri(live.webAppUrl),
            state,
            agentBots: true,
            afterConsent: true
          })
        }
      }
    )

    r.post(
      '/integrations/msteams/connect/callback',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Finish connecting a Microsoft 365 tenant',
          description:
            'Redeem the code Microsoft returned, take the tenant from the ID token, and connect it: a tenant another organization holds answers 409 MSTEAMS_TENANT_TAKEN, and one this organization connects to another agent answers 409 MSTEAMS_TENANT_IN_USE. The tenant’s row is installed on the agent, the app is published to the tenant’s organization catalog, each of the administrator’s teams that already has the app is upgraded to it with its resource-specific permissions re-consented, and the administrator’s teams are answered with a short-lived ticket for the install step. Running it again for the same agent is how the Console updates the app in Teams.',
          operationId: 'finishMsTeamsConnect',
          body: CallbackBody,
          response: { 200: CallbackDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ConflictDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const orgId = orgOf(req)
        const state = verifyMsTeamsConnectState(seams.keys, req.body.state, deps.clock)
        // The consent's state redeems no code.
        if (!state || state.consent || state.orgId !== orgId || state.userId !== req.principal.userId) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        const target = await connectTarget(deps, req, state.agentId)
        if (typeof target === 'string') return refuse(reply, 409, 'MSTEAMS_CONNECT_NO_AGENT', target)
        const relayBase = relayHttpBase(deps.config.PUBLIC_RELAY_URL)
        const ingress = relayIngress(deps)
        if (!relayBase || !ingress.ok) {
          return refuse(reply, 409, 'MSTEAMS_RELAY_ORIGIN_MISSING', 'This deployment has no public callback endpoint.')
        }
        try {
          const {
            accessToken,
            tenantId,
            userId: sponsorId,
            refreshToken
          } = await redeemMsTeamsCode(
            seams.keys,
            {
              clientId: live.app.appId,
              clientSecret: live.app.clientSecret,
              redirectUri: msTeamsConnectRedirectUri(live.webAppUrl),
              code: req.body.code,
              state: req.body.state,
              ...(state.tenant ? { tenant: state.tenant } : {}),
              ...(state.agentBots ? { agentBots: true } : {}),
              ...(state.pin ? { pin: state.pin } : {})
            },
            fetchImpl
          )
          const tenantRows = () =>
            deps.repos.bot
              .listForPlatform(MSTEAMS_PLATFORM)
              .then((rows) => msTeamsRecoveryRows(rows, live.app.appId, tenantId))
          const before = await tenantRows()
          // The sign-in asked the agent bots' scopes, so their steps can run with it.
          const agentBots = state.agentBots ? agentBotClient : undefined
          // A Teams Store install already has the app, so this connect only claims the tenant (§8.4).
          const store = state.tenant !== undefined

          const taken = () =>
            reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              code: 'MSTEAMS_TENANT_TAKEN',
              message: TAKEN_MESSAGE,
              recovery: { tenantId, agentId: target.id }
            })
          if (before.some((row) => row.orgId !== orgId)) return taken()
          const held = before.find((row) => row.externalAppId === live.app.appId)
          // A person signed in at a tenant this organization has not connected may be a guest of the one it has: they are signed in there once, silently (§8.6.6).
          if (state.agentBots && !state.consented && !state.pin && before.length === 0) {
            const connected = new Set(
              (await deps.repos.bot.listForOrg(orgId))
                .filter(
                  (row) => row.platform === MSTEAMS_PLATFORM && isMsTeamsDeploymentRow(row) && row.externalTenantId
                )
                .map((row) => row.externalTenantId!)
            )
            const username = connected.size === 1 ? await readMsTeamsUsername(fetchImpl, accessToken) : ''
            if (username) {
              const pin = [...connected][0]!
              const silent = mintMsTeamsConnectState(
                seams.keys,
                { orgId, agentId: target.id, userId: req.principal.userId, agentBots: true, pin },
                deps.clock
              )
              return {
                agentId: target.id,
                teams: [],
                store: false,
                authorizeUrl: msTeamsAuthorizeUrl(seams.keys, {
                  clientId: live.app.appId,
                  redirectUri: msTeamsConnectRedirectUri(live.webAppUrl),
                  state: silent,
                  agentBots: true,
                  pin,
                  silentFor: username
                })
              }
            }
          }
          // A sign-in that skipped the consent page is for a tenant that recorded it; another tenant of the organization goes back through it.
          if (
            state.agentBots &&
            !state.consented &&
            !before.some((row) => row.platformConfig?.[MSTEAMS_TENANT_CONSENT_KEY] === MSTEAMS_TENANT_CONSENT_VERSION)
          )
            return refuse(reply, 409, 'MSTEAMS_CONSENT_NEEDED', CONSENT_NEEDED_MESSAGE)
          const consentRecord = { platformConfig: { [MSTEAMS_TENANT_CONSENT_KEY]: MSTEAMS_TENANT_CONSENT_VERSION } }
          const servesAnother = !!held && held.agentIds.length > 0 && !held.agentIds.includes(target.id)
          // The app's bot serves the agent connected first; a further agent gets a bot of its own where the deployment makes them (§8.6.4), and keeps it on a reconnect.
          if (
            servesAnother ||
            (agentBots &&
              sponsorId &&
              before.some((row) => !!msTeamsAgentBotOf(row) && row.agentIds.includes(target.id)))
          ) {
            if (!agentBots || !sponsorId) return refuse(reply, 409, 'MSTEAMS_TENANT_IN_USE', IN_USE_MESSAGE)
            // A request waiting for approval goes on with this sign-in, and is finished here if it was approved meanwhile (§8.6.6).
            const open = seams.requests
              ? (await deps.repos.msTeamsAgentBotRequest.listForAgent(orgId, target.id)).find(
                  (request) => request.tenantId === tenantId
                )
              : undefined
            if (open && seams.requests) {
              if (refreshToken)
                await deps.repos.msTeamsAgentBotRequest.resume(orgId, open.id, refreshToken, new Date(deps.clock.now()))
              const checked = await seams.requests.check(orgId, open.id)
              const resumed = await deps.repos.msTeamsAgentBotRequest.get(orgId, open.id)
              return {
                agentId: target.id,
                agentBot: true,
                teams: [],
                store: false,
                ...(checked.outcome === 'installed' ? { integrationId: checked.integrationId } : {}),
                ...(resumed ? { request: requestDto(resumed) } : {})
              }
            }
            const holder = await nameHolder(deps, orgId, tenantId, target)
            if (holder) return refuse(reply, 409, 'MSTEAMS_AGENT_NAME_TAKEN', NAME_TAKEN_MESSAGE(holder))
            if (state.consented && held) await deps.repos.bot.mergeBotIdentity(orgId, held.id, () => consentRecord)
            // Making the bot takes up to most of a minute, so it is its own step (§8.6.5); it joins a team when someone mentions it there.
            return {
              agentId: target.id,
              agentBot: true,
              teams: [],
              ticket: sealMsTeamsTicket(
                seams.keys,
                {
                  accessToken,
                  ...(refreshToken ? { refreshToken } : {}),
                  orgId,
                  agentBot: { agentId: target.id, tenantId, sponsorId, userId: req.principal.userId }
                },
                deps.clock
              ),
              store: false
            }
          }
          // The blueprint's principal is created at the first connect too, so a member can add an agent later (§8.6.5); the first agent does not depend on it.
          if (agentBots && !store)
            await agentBots
              .ensurePrincipal(tenantId, accessToken)
              .catch((err: unknown) =>
                req.log.warn({ err }, 'msteams: could not create the blueprint’s principal in the tenant')
              )

          // Preserve the existing catalog connect behavior; recovery verifies administrator authority separately.
          const packageInput = {
            appId: live.app.appId,
            relayHost: new URL(relayBase).host,
            agentName: target.displayName ?? target.name,
            nameLabel: deps.config.MSTEAMS_APP_LABEL,
            accentColor: agentIconBackgroundColor(target.icon)
          }
          const appPackage = msTeamsPackageFingerprint(packageInput, target)
          const catalogAppId = store
            ? undefined
            : await publishMsTeamsPackage(
                fetchImpl,
                accessToken,
                msTeamsPackageId(live.app.appId),
                msTeamsAppPackage(
                  msTeamsManifest({ ...packageInput, nowMs: deps.clock.now() }),
                  await msTeamsAppIcons(target, deps.iconStore)
                )
              )

          const organizationName = held ? undefined : await readMsTeamsOrganizationName(fetchImpl, accessToken)
          const connected = await seams.bindingMutations.runExclusive(tenantId, async () => {
            if (msTeamsRecoverySnapshot(await tenantRows()) !== msTeamsRecoverySnapshot(before))
              throw msTeamsRecoveryChanged()
            const currentTarget = await connectTarget(deps, req, state.agentId)
            if (typeof currentTarget === 'string') throw msTeamsRecoveryChanged()
            let integrationId: string
            let botId = held?.id
            if (!held) {
              try {
                const installed = await installNewBot(deps, req.log, {
                  bot: {
                    externalAppId: live.app.appId,
                    platformConfig: {
                      tenantId,
                      tokenTenantId: live.app.tenantId,
                      // Marks the row as the deployment app's for good, whatever its settings say later (§8.5).
                      [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER,
                      ...(store ? { source: 'store' } : {})
                    }
                  },
                  // The row stores no secret; its daemon sends through the relay (§8.5).
                  secrets: msTeamsDeploymentSecrets(),
                  externalIdentity: {
                    externalAppId: live.app.appId,
                    externalTenantId: tenantId,
                    conflictMessage: TAKEN_MESSAGE
                  },
                  orgId,
                  agent: currentTarget,
                  platform: MSTEAMS_PLATFORM,
                  // The organization's own name, as the console lists it; the tenant ID only when Graph names none.
                  name: `Microsoft Teams · ${organizationName ?? tenantId}`,
                  transport: 'http',
                  prebuilt: true,
                  createdByUserId: req.principal!.userId
                })
                integrationId = installed.integration.id
                botId = installed.bot.id
              } catch (err) {
                if (err instanceof BotExternalIdentityTaken)
                  throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
                throw err
              }
            } else {
              const admission = await deps.repos.integration.addBotMembership({
                id: IntegrationId(randomUUID()),
                orgId,
                agentId: target.id,
                botId: held.id,
                platform: MSTEAMS_PLATFORM,
                name: held.name,
                createdByUserId: req.principal!.userId
              })
              if (admission.outcome === 'revoked' || admission.outcome === 'not_shareable') {
                throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_IN_USE', IN_USE_MESSAGE)
              }
              if (admission.outcome === 'added') {
                if (held.platformConfig?.[MSTEAMS_ROW_OWNER_KEY] !== MSTEAMS_DEPLOYMENT_OWNER)
                  await deps.repos.bot.mergeBotIdentity(orgId, held.id, () => ({
                    platformConfig: { [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER }
                  }))
                await deps.repos.botCredential.install(
                  orgId,
                  held.id,
                  msTeamsDeploymentSecrets(),
                  new Date(deps.clock.now())
                )
                await deps.httpBot.syncBot(held.id)
              }
              integrationId = admission.integration.id
            }

            return { integrationId, botId }
          })
          const { integrationId, botId } = connected
          if (state.consented && botId) await deps.repos.bot.mergeBotIdentity(orgId, botId, () => consentRecord)

          if (!catalogAppId) {
            // The Store keeps the package current; recording the source keeps Update in Teams off its row.
            if (botId)
              await deps.repos.bot.mergeBotIdentity(orgId, botId, () => ({ platformConfig: { source: 'store' } }))
            return { integrationId, agentId: target.id, teams: [], store: true }
          }
          // A team that already has the app takes the new definition and re-consents its permissions here (§8.3).
          const teams = await listMsTeamsTeams(fetchImpl, accessToken)
          const upgrades = await upgradeMsTeamsInstalls(
            fetchImpl,
            accessToken,
            { teamIds: teams.map((team) => team.id), catalogAppId, permissions: MSTEAMS_RSC_PERMISSIONS },
            req.log
          )
          // A team left on the old package keeps Update in Teams on offer (§5.1).
          if (botId && ![...upgrades.values()].includes('failed')) {
            await deps.repos.bot.mergeBotIdentity(orgId, botId, () => ({ platformConfig: { appPackage } }))
          }
          return {
            integrationId,
            agentId: target.id,
            teams: teams.map((team) => ({ ...team, app: upgrades.get(team.id) ?? 'failed' })),
            ticket: sealMsTeamsTicket(seams.keys, { accessToken, orgId, integrationId, catalogAppId }, deps.clock),
            store: false
          }
        } catch (err) {
          if (err instanceof MsTeamsRecoveryError) return refuse(reply, err.status, err.code, err.message)
          if (err instanceof MsTeamsConnectError) return refuseConnect(req, reply, err)
          throw err
        }
      }
    )

    r.post(
      '/integrations/msteams/connect/agent-bot',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Create a further agent’s own Teams bot',
          description:
            'For a tenant that already serves another agent: with the ticket the connect step answered, create the agent’s bot (the blueprint’s principal if the tenant has none, the agent identity, its bot registration, and a proof token), publish its package to the tenant’s organization catalog, and install its row on the agent. Answers the integration, the administrator’s teams with the app’s state in each, and the ticket for the install step. Safe to repeat: a retry finds what an earlier attempt created. A tenant where the bot cannot be created answers 409 MSTEAMS_AGENT_BOTS_UNAVAILABLE with Microsoft’s reason.',
          operationId: 'createMsTeamsAgentBot',
          body: AgentBotBody,
          response: { 200: CallbackDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const live = usable()
        if (!live || !agentBotClient || !seams.agentBots || !req.principal)
          return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment makes no bots for further agents.')
        const orgId = orgOf(req)
        const ticket = openMsTeamsTicket(seams.keys, req.body.ticket, deps.clock)
        if (
          !ticket ||
          !('agentBot' in ticket) ||
          ticket.orgId !== orgId ||
          ticket.agentBot.userId !== req.principal.userId
        ) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        const { accessToken } = ticket
        const { tenantId, sponsorId } = ticket.agentBot
        const target = await connectTarget(deps, req, ticket.agentBot.agentId)
        if (typeof target === 'string') return refuse(reply, 409, 'MSTEAMS_CONNECT_NO_AGENT', target)
        const relayBase = relayHttpBase(deps.config.PUBLIC_RELAY_URL)
        if (!relayBase || !relayIngress(deps).ok) {
          return refuse(reply, 409, 'MSTEAMS_RELAY_ORIGIN_MISSING', 'This deployment has no public callback endpoint.')
        }
        const holder = await nameHolder(deps, orgId, tenantId, target)
        if (holder) return refuse(reply, 409, 'MSTEAMS_AGENT_NAME_TAKEN', NAME_TAKEN_MESSAGE(holder))
        const agentName = target.displayName ?? target.name
        const key = msTeamsAgentBotKey(target.id, tenantId)
        let identity: string
        try {
          await agentBotClient.ensurePrincipal(tenantId, accessToken)
          identity = await agentBotClient.ensureIdentity({
            tenantId,
            key,
            displayName: agentName,
            sponsorUserId: sponsorId
          })
          await agentBotClient.ensureRegistration({
            key,
            tenantId,
            identity,
            displayName: agentName,
            relayPublicUrl: relayBase
          })
          await agentBotClient.prove(tenantId, identity)
        } catch (err) {
          if (!(err instanceof MsTeamsAgentBotError)) throw err
          req.log.warn({ step: err.step, status: err.status, code: err.providerCode }, 'msteams: agent bot not created')
          if (err.transient)
            return refuse(reply, 502, 'MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft could not be reached. Try again.')
          const reason = `${err.step}${err.providerCode ? `: ${err.providerCode}` : ''}`
          return refuse(reply, 409, 'MSTEAMS_AGENT_BOTS_UNAVAILABLE', AGENT_BOTS_UNAVAILABLE_MESSAGE(reason))
        }
        try {
          // The package names the identity as its bot and the blueprint as its consent app (§8.6.1).
          const packageInput = {
            appId: identity,
            consentAppId: seams.agentBots.blueprintId,
            relayHost: new URL(relayBase).host,
            agentName,
            nameLabel: deps.config.MSTEAMS_APP_LABEL,
            accentColor: agentIconBackgroundColor(target.icon)
          }
          const appPackage = msTeamsPackageFingerprint(packageInput, target)
          const zip = msTeamsAppPackage(
            msTeamsManifest({ ...packageInput, nowMs: deps.clock.now() }),
            await msTeamsAppIcons(target, deps.iconStore)
          )
          const organizationName = await readMsTeamsOrganizationName(fetchImpl, accessToken)
          const userId = req.principal.userId
          let catalogAppId: string
          try {
            catalogAppId = await publishMsTeamsPackage(fetchImpl, accessToken, msTeamsPackageId(identity), zip)
          } catch (err) {
            // Microsoft lets only an administrator publish: anyone else's package is submitted, and waits for one to publish it in the Teams admin center (§8.6.6).
            const { refreshToken } = ticket
            if (
              !(err instanceof MsTeamsConnectError) ||
              err.code !== 'MSTEAMS_CONNECT_NOT_ADMIN' ||
              !seams.requests ||
              !refreshToken
            )
              throw err
            // An agent that already has its bot is updated by an administrator's connect, not by a new submission.
            if (await deps.repos.bot.getByExternalIdentity(MSTEAMS_PLATFORM, identity, tenantId))
              throw new MsTeamsRecoveryError(409, 'MSTEAMS_AGENT_ALREADY_CONNECTED', ALREADY_CONNECTED_MESSAGE)
            const submitted = await submitMsTeamsPackage(fetchImpl, accessToken, msTeamsPackageId(identity), zip)
            // The request is stored under the tenant's lock, for an organization that still holds the tenant (§8.7).
            const request = await seams.bindingMutations.runExclusive(tenantId, async () => {
              const rows = msTeamsRecoveryRows(
                await deps.repos.bot.listForPlatform(MSTEAMS_PLATFORM),
                live.app.appId,
                tenantId
              )
              if (rows.some((row) => row.orgId !== orgId))
                throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
              if (rows.length === 0)
                throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_NOT_CONNECTED', NOT_CONNECTED_MESSAGE)
              return await deps.repos.msTeamsAgentBotRequest.create({
                id: randomUUID(),
                orgId,
                agentId: target.id,
                tenantId,
                createdByUserId: userId,
                sponsorId,
                identity,
                catalogAppId: submitted,
                teamIds: [],
                appPackage,
                botName: `Microsoft Teams · ${organizationName ?? tenantId}`,
                refreshToken,
                nextCheckAt: new Date(deps.clock.now() + MSTEAMS_REQUEST_FIRST_CHECK_MS)
              })
            })
            return { agentId: target.id, agentBot: true, teams: [], store: false, request: requestDto(request) }
          }
          const blueprintId = seams.agentBots.blueprintId
          // Connects and recovery serialize per tenant, across every deployment-owned bot.
          const { integrationId, botId } = await seams.bindingMutations.runExclusive(tenantId, async () => {
            const held = await deps.repos.bot.getByExternalIdentity(MSTEAMS_PLATFORM, identity, tenantId)
            // The tenant may have changed hands while the bot was being made.
            const rows = msTeamsRecoveryRows(
              await deps.repos.bot.listForPlatform(MSTEAMS_PLATFORM),
              live.app.appId,
              tenantId
            )
            if (rows.some((row) => row.orgId !== orgId) || (held && held.orgId !== orgId))
              throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
            if (!held) {
              const installed = await installNewBot(deps, req.log, {
                bot: {
                  externalAppId: identity,
                  platformConfig: {
                    tenantId,
                    // An agent bot's tokens are issued by its own tenant (§8.6.4).
                    tokenTenantId: tenantId,
                    [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER,
                    ...msTeamsAgentBotEntries({
                      blueprintId,
                      resourceName: msTeamsAgentBotResourceName(key)
                    })
                  }
                },
                secrets: msTeamsDeploymentSecrets(),
                externalIdentity: {
                  externalAppId: identity,
                  externalTenantId: tenantId,
                  conflictMessage: TAKEN_MESSAGE
                },
                orgId,
                agent: target,
                platform: MSTEAMS_PLATFORM,
                name: `Microsoft Teams · ${organizationName ?? tenantId}`,
                transport: 'http',
                prebuilt: true,
                createdByUserId: userId
              })
              return { integrationId: installed.integration.id as string, botId: installed.bot.id }
            } else {
              const admission = await deps.repos.integration.addBotMembership({
                id: IntegrationId(randomUUID()),
                orgId,
                agentId: target.id,
                botId: held.id,
                platform: MSTEAMS_PLATFORM,
                name: held.name,
                createdByUserId: userId
              })
              if (admission.outcome === 'revoked' || admission.outcome === 'not_shareable') {
                throw new MsTeamsRecoveryError(409, 'MSTEAMS_TENANT_IN_USE', IN_USE_MESSAGE)
              }
              if (admission.outcome === 'added') await deps.httpBot.syncBot(held.id)
              return { integrationId: admission.integration.id as string, botId: held.id }
            }
          })
          await deps.repos.bot.mergeBotIdentity(orgId, botId, () => ({ platformConfig: { appPackage } }))
          // The person who connects the agent gets its app themselves; Microsoft refuses a just-published app for some minutes, so the tries go on after the answer.
          const log = req.log
          void installMsTeamsAppForUserEventually(
            fetchImpl,
            accessToken,
            { userId: sponsorId, catalogAppId, permissions: MSTEAMS_RSC_PERMISSIONS },
            seams.personalInstallWait ?? sleepUnref
          )
            .then((detail) => {
              if (detail)
                log.warn({ integrationId, detail }, 'msteams: agent bot not added for the person who connected it')
            })
            .catch((err: unknown) =>
              log.warn({ integrationId, err }, 'msteams: adding the agent bot for its person failed')
            )
          return {
            integrationId,
            agentId: target.id,
            teams: [],
            store: false
          }
        } catch (err) {
          if (err instanceof BotExternalIdentityTaken) return refuse(reply, 409, 'MSTEAMS_TENANT_TAKEN', TAKEN_MESSAGE)
          if (err instanceof MsTeamsConnectError) return refuseConnect(req, reply, err)
          if (err instanceof MsTeamsRecoveryError) return refuse(reply, err.status, err.code, err.message)
          throw err
        }
      }
    )

    r.get(
      '/integrations/msteams/requests',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'List an agent’s pending Teams bot requests',
          description:
            'The requests for this agent’s own Teams bot that still wait for a Teams administrator’s approval, or stopped for a reason the status names. Never returns the stored sign-in.',
          operationId: 'listMsTeamsAgentBotRequests',
          querystring: z.object({ agentId: z.uuid() }),
          response: { 200: z.object({ requests: z.array(RequestDto) }), 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.query.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return refuse(reply, 404, 'NOT_FOUND', 'Agent not found.')
        const requests = await deps.repos.msTeamsAgentBotRequest.listForAgent(orgOf(req), agent.id)
        return { requests: requests.map(requestDto) }
      }
    )

    // The request an editor of its agent may act on; a string names the refusal.
    const editableRequest = async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const request = await deps.repos.msTeamsAgentBotRequest.get(orgOf(req), req.params.id)
      const agent = request ? await deps.repos.agent.get(orgOf(req), request.agentId) : null
      if (!request || !agent || !canView(agent, ctxOf(req))) return 'not_found' as const
      return canEdit(agent, ctxOf(req)) ? request : ('forbidden' as const)
    }

    r.post(
      '/integrations/msteams/requests/:id/check',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check a pending Teams bot request now',
          description:
            'Read the package’s state at once instead of waiting for the next background check. Once a Teams administrator has approved it, this installs it into the chosen teams and connects the agent, and answers the integration; otherwise it answers the request as it stands.',
          operationId: 'checkMsTeamsAgentBotRequest',
          params: IdParam,
          response: {
            200: z.object({ integrationId: z.string().optional(), request: RequestDto.optional() }),
            403: ErrorDto,
            404: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const request = await editableRequest(req)
        if (request === 'forbidden') return refuse(reply, 403, 'FORBIDDEN', 'You cannot edit this agent.')
        if (request === 'not_found' || !seams.requests) return refuse(reply, 404, 'NOT_FOUND', 'Request not found.')
        const checked = await seams.requests.check(orgOf(req), request.id)
        if (checked.outcome === 'installed') return { integrationId: checked.integrationId }
        const current = await deps.repos.msTeamsAgentBotRequest.get(orgOf(req), request.id)
        return current ? { request: requestDto(current) } : {}
      }
    )

    r.delete(
      '/integrations/msteams/requests/:id',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Cancel a pending Teams bot request',
          description:
            'Withdraw the package from review where the stored sign-in still works, delete the agent’s bot registration and identity, and forget the request with its stored sign-in. Answers 502 when Microsoft could not be reached, and nothing is forgotten.',
          operationId: 'cancelMsTeamsAgentBotRequest',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const request = await editableRequest(req)
        if (request === 'forbidden') return refuse(reply, 403, 'FORBIDDEN', 'You cannot edit this agent.')
        if (request === 'not_found' || !seams.requests) return refuse(reply, 404, 'NOT_FOUND', 'Request not found.')
        try {
          await seams.requests.cancel(orgOf(req), request.id)
        } catch (err) {
          if (err instanceof MsTeamsRequestBusy)
            return refuse(reply, 409, 'MSTEAMS_REQUEST_BUSY', 'The request is being checked. Try again in a moment.')
          req.log.warn({ err, requestId: request.id }, 'msteams: agent bot request not cancelled')
          return refuse(reply, 502, 'MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft could not be reached. Try again.')
        }
        return reply.code(204).send(null)
      }
    )

    r.post(
      '/integrations/msteams/connect/install',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Install the Teams app into teams',
          description:
            'Install the connected tenant’s catalog app into each chosen team with the package’s resource-specific permissions, using the ticket the connect step answered. A team that already has the app counts as installed.',
          operationId: 'installMsTeamsApp',
          body: InstallBody,
          response: { 200: InstallDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!usable()) return refuse(reply, 404, 'MSTEAMS_CONNECT_UNAVAILABLE', 'This deployment has no Teams app.')
        const ticket = openMsTeamsTicket(seams.keys, req.body.ticket, deps.clock)
        if (!ticket || !('catalogAppId' in ticket) || ticket.orgId !== orgOf(req)) {
          return refuse(
            reply,
            400,
            'MSTEAMS_CONNECT_STATE_INVALID',
            'This sign-in has expired. Start connecting again.'
          )
        }
        try {
          for (const teamId of req.body.teamIds) {
            const integration = await deps.repos.integration.get(orgOf(req), IntegrationId(ticket.integrationId))
            if (!integration || typeof (await connectTarget(deps, req, integration.agentId)) === 'string')
              return refuse(
                reply,
                409,
                'MSTEAMS_CONNECT_STATE_INVALID',
                'This connection changed. Start connecting again.'
              )
            await installMsTeamsApp(fetchImpl, ticket.accessToken, {
              teamId,
              catalogAppId: ticket.catalogAppId,
              permissions: MSTEAMS_RSC_PERMISSIONS
            })
          }
        } catch (err) {
          if (err instanceof MsTeamsConnectError) return refuseConnect(req, reply, err)
          throw err
        }
        return { installed: req.body.teamIds.length }
      }
    )
  }
}
