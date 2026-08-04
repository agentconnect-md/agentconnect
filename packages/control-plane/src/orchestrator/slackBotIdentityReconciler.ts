/**
 * Repairs Slack bot rows created before public app/workspace identity was
 * persisted. Values are resolved from the already-stored bot token. The app id
 * is written only while missing; workspace metadata is display-only.
 *
 * This is a background convergence loop, not part of GET /bots: opening the
 * Settings page must not fan out to Slack or turn a metadata read into a write.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type { BotRepo, BotSecretStore } from '../persistence/ports.js'

export interface SlackBotIdentityReconcilerConfig {
  intervalMs: number
  /** Refresh conversation-scoped mention directories after a member id is repaired. */
  onMentionIdentityChanged?: (orgId: OrgId) => Promise<void>
}

export interface SlackBotIdentityReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface ResolvedSlackIdentity {
  appId: string | null
  botUserId?: string | null
  workspaceId: string | null
  workspaceName: string | null
}

export type ResolveSlackIdentity = (botToken: string) => Promise<ResolvedSlackIdentity | null>

const SLACK_APP_ID = /^A[A-Z0-9]+$/
const SLACK_MEMBER_ID = /^[A-Z][A-Z0-9]+$/
const SLACK_WORKSPACE_ID = /^T[A-Z0-9]+$/

export class SlackBotIdentityReconciler {
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false
  /** Retained across ticks so a transient broadcast failure cannot strand repaired data. */
  private readonly pendingMentionIdentityOrgs = new Set<OrgId>()

  constructor(
    private readonly bots: BotRepo,
    private readonly secrets: BotSecretStore,
    private readonly resolveIdentity: ResolveSlackIdentity,
    private readonly clock: Clock,
    private readonly cfg: SlackBotIdentityReconcilerConfig,
    private readonly log?: SlackBotIdentityReconcilerLog
  ) {}

  /** Run immediately on boot, then retry unresolved rows periodically. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  /** One best-effort pass. Exposed for deterministic unit tests. */
  async tick(): Promise<void> {
    if (this.running) return
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.running = true
    try {
      for (const bot of await this.bots.listSlackMissingIdentity()) {
        try {
          const secret = await this.secrets.get(bot.id)
          if (!secret) continue
          const identity = await this.resolveIdentity(secret.botToken)
          if (!identity) continue
          if (identity.appId && SLACK_APP_ID.test(identity.appId)) {
            if (await this.bots.setSlackAppIdIfMissing(bot.id, identity.appId)) {
              this.log?.info({ botId: bot.id, slackAppId: identity.appId }, 'slack-bot-identity: backfilled app id')
            }
          }
          if (identity.botUserId && SLACK_MEMBER_ID.test(identity.botUserId)) {
            if (await this.bots.setSlackBotUserIdIfMissing(bot.id, identity.botUserId)) {
              this.log?.info(
                { botId: bot.id, botUserId: identity.botUserId },
                'slack-bot-identity: backfilled bot user id'
              )
              if (this.cfg.onMentionIdentityChanged) this.pendingMentionIdentityOrgs.add(bot.orgId)
            }
          }
          if (identity.workspaceId && SLACK_WORKSPACE_ID.test(identity.workspaceId)) {
            await this.bots.setWorkspaceMetadata(bot.id, identity.workspaceId, identity.workspaceName)
            this.log?.info(
              { botId: bot.id, workspaceId: identity.workspaceId },
              'slack-bot-identity: refreshed workspace metadata'
            )
          }
        } catch (err) {
          this.log?.warn({ err, botId: bot.id }, 'slack-bot-identity: bot lookup failed')
        }
      }
      for (const orgId of this.pendingMentionIdentityOrgs) {
        try {
          await this.cfg.onMentionIdentityChanged?.(orgId)
          this.pendingMentionIdentityOrgs.delete(orgId)
        } catch (err) {
          this.log?.warn({ err, orgId }, 'slack-bot-identity: mention directory refresh failed')
        }
      }
    } catch (err) {
      this.log?.error({ err }, 'slack-bot-identity: reconciliation failed')
    } finally {
      this.running = false
      this.arm()
    }
  }
}
