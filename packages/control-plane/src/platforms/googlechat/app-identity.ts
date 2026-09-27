// How the Control Plane learns a Chat app's own `users/…` identity (google-chat-integration.md §3): from one Space it belongs to.
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { BotRepo, BotSecretStore } from '../../persistence/ports.js'
import {
  GOOGLE_CHAT_API_ROOT,
  GOOGLE_CHAT_BOT_SCOPE,
  checkServiceAccountKey,
  mintAccessToken,
  type GoogleServiceAccountKey
} from './credential.js'

const READ_TIMEOUT_MS = 5_000
const USER_NAME = /^users\/[A-Za-z0-9._-]+$/
const SPACE_NAME = /^spaces\/[A-Za-z0-9._-]+$/

export type GoogleChatAppIdentityResult =
  | { status: 'ok'; appUserName: string }
  /** The app is in no Space yet; nothing can name it until someone adds it. */
  | { status: 'no_space' }
  | { status: 'failed'; message: string }

type Read = { ok: true; body: Record<string, unknown> } | { ok: false; message: string }

async function readJson(fetchImpl: typeof fetch, url: string, accessToken: string): Promise<Read> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, message: 'the Google Chat API could not be reached' }
  }
  if (!response.ok) return { ok: false, message: `the Google Chat API answered HTTP ${response.status}` }
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return { ok: true, body: body as Record<string, unknown> }
    }
  } catch {
    // Fall through: an unreadable body is the same failure.
  }
  return { ok: false, message: 'the Google Chat API answered without a JSON object' }
}

/** The app's `users/…` name: its own membership (`members/app`) in the first Space it belongs to. Never sends a message. */
export async function resolveGoogleChatAppIdentity(
  key: GoogleServiceAccountKey,
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date()
): Promise<GoogleChatAppIdentityResult> {
  const minted = await mintAccessToken(key, GOOGLE_CHAT_BOT_SCOPE, fetchImpl, now)
  if ('status' in minted) return { status: 'failed', message: minted.message }
  const spaces = await readJson(fetchImpl, `${GOOGLE_CHAT_API_ROOT}/spaces?pageSize=1`, minted.accessToken)
  if (!spaces.ok) return { status: 'failed', message: spaces.message }
  const first = Array.isArray(spaces.body.spaces)
    ? (spaces.body.spaces[0] as { name?: unknown } | undefined)
    : undefined
  const space = typeof first?.name === 'string' && SPACE_NAME.test(first.name) ? first.name : undefined
  if (!space) return { status: 'no_space' }
  const membership = await readJson(fetchImpl, `${GOOGLE_CHAT_API_ROOT}/${space}/members/app`, minted.accessToken)
  if (!membership.ok) return { status: 'failed', message: membership.message }
  const name = (membership.body.member as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string' || !USER_NAME.test(name)) {
    return { status: 'failed', message: 'the app membership carried no users/… name' }
  }
  return { status: 'ok', appUserName: name }
}

export interface GoogleChatAppIdentityReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface GoogleChatAppIdentityReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform' | 'setBotUserIdIfMissing'>
  secrets: Pick<BotSecretStore, 'get'>
  /** The Google HTTP layer; tests pass a fake. */
  fetch: typeof fetch
  /** Re-broadcast `rc/bot-assign` so connected relays carry the identity now rather than at their next assignment. */
  resync(botId: BotId): Promise<void>
  clock: Clock
  intervalMs: number
  log?: GoogleChatAppIdentityReconcilerLog
}

/** A background pass, after the Slack bot-identity reconciler: a Chat app's key never names the app, only Google does. */
export class GoogleChatAppIdentityReconciler {
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false

  constructor(private readonly deps: GoogleChatAppIdentityReconcilerDeps) {}

  /** Run immediately on boot, then retry the rows still without an identity periodically. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => void this.tick(), this.deps.intervalMs)
  }

  /** One best-effort pass over every Google Chat bot still missing its identity. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.running) return
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.running = true
    try {
      for (const bot of await this.deps.bots.listForPlatform(GOOGLE_CHAT_PLATFORM)) {
        // A revoked bot's key is dead; a row without its project cannot check the key it holds.
        const projectId = bot.platformConfig?.projectId
        if (bot.botUserId !== null || bot.revokedAt !== null || typeof projectId !== 'string') continue
        try {
          const secret = await this.deps.secrets.get(bot.orgId, bot.id)
          if (!secret) continue
          const checked = checkServiceAccountKey(secret.botToken, projectId)
          if (checked.status !== 'ok') {
            this.deps.log?.warn({ botId: bot.id }, `googlechat-app-identity: stored key unusable (${checked.status})`)
            continue
          }
          const identity = await resolveGoogleChatAppIdentity(
            checked.key,
            this.deps.fetch,
            () => new Date(this.deps.clock.now())
          )
          if (identity.status === 'failed') {
            this.deps.log?.warn({ botId: bot.id }, `googlechat-app-identity: lookup failed: ${identity.message}`)
            continue
          }
          if (identity.status === 'no_space') continue
          if (await this.deps.bots.setBotUserIdIfMissing(bot.id, identity.appUserName)) {
            this.deps.log?.info(
              { botId: bot.id, botUserId: identity.appUserName },
              'googlechat-app-identity: backfilled the app user name'
            )
            // The row is durable either way; a relay that misses this broadcast learns from the next assignment.
            await this.deps.resync(bot.id)
          }
        } catch (err) {
          this.deps.log?.warn({ err, botId: bot.id }, 'googlechat-app-identity: bot lookup failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'googlechat-app-identity: reconciliation failed')
    } finally {
      this.running = false
      this.arm()
    }
  }
}
