// Organization GitHub Apps: metadata rows, the org-sealed key and webhook secret, and the agent switch (§Organization GitHub Apps).
import type { GithubApp, Prisma, PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  GithubAppRecord,
  GithubAppRepo,
  GithubAppSecretStore,
  GithubAppSwitchRefusal,
  GithubAppWebhook
} from '../ports.js'
import { OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'

const withAgent = { agent: { select: { id: true } } } as const

function toRecord(r: GithubApp & { agent: { id: string } | null }): GithubAppRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    agentId: r.agent?.id ?? null,
    appId: r.appId,
    slug: r.slug,
    clientId: r.clientId,
    botUserId: r.botUserId,
    createdAt: r.createdAt
  }
}

class SwitchRefused extends Error {
  constructor(readonly refusal: GithubAppSwitchRefusal) {
    super(refusal.kind)
  }
}

export class PgGithubAppRepo implements GithubAppRepo {
  constructor(private readonly prisma: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.prisma) return (this.prisma as PrismaClient).$transaction(fn)
    return fn(this.prisma as Prisma.TransactionClient)
  }

  async create(input: {
    id: string
    orgId: OrgId
    appId: bigint
    slug: string
    clientId: string | null
    botUserId: bigint | null
  }): Promise<GithubAppRecord> {
    return toRecord(await this.prisma.githubApp.create({ data: input, include: withAgent }))
  }

  async get(orgId: OrgId, id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id, orgId }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async getUnscoped(id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async getByAppId(appId: bigint): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { appId }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<GithubAppRecord[]> {
    const rows = await this.prisma.githubApp.findMany({
      where: { orgId },
      include: withAgent,
      orderBy: { slug: 'asc' }
    })
    return rows.map(toRecord)
  }

  async switchAgent(input: {
    orgId: OrgId
    agentId: string
    from: string | null
    to: string | null
  }): Promise<{ ok: true } | ({ ok: false } & GithubAppSwitchRefusal)> {
    const { orgId, agentId, from, to } = input
    try {
      await this.transaction(async (tx) => {
        if (to !== null && (await tx.githubApp.count({ where: { id: to, orgId } })) === 0) {
          throw new SwitchRefused({ kind: 'app_in_use' })
        }
        // Compare-and-set on the agent row; the unique index refuses an App another agent already works through.
        const moved = await tx.agent.updateMany({
          where: { id: agentId, orgId, githubAppId: from },
          data: { githubAppId: to }
        })
        if (moved.count === 0) throw new SwitchRefused({ kind: 'agent_changed' })

        // Every installation the agent records moves to the target App's installation on the same account.
        const target = new Map<string, { id: string; installationId: bigint }>()
        const resolve = async (accountLogin: string) => {
          const key = accountLogin.toLowerCase()
          let hit = target.get(key)
          if (!hit) {
            const row = await tx.githubInstallation.findFirst({
              where: {
                orgId,
                githubAppId: to,
                revokedAt: null,
                accountLogin: { equals: accountLogin, mode: 'insensitive' }
              },
              select: { id: true, installationId: true }
            })
            if (!row) throw new SwitchRefused({ kind: 'missing_installation', accountLogin })
            hit = row
            target.set(key, hit)
          }
          return hit
        }
        const accountOf = async (installationId: bigint) =>
          (await tx.githubInstallation.findUnique({ where: { installationId }, select: { accountLogin: true } }))
            ?.accountLogin ?? null

        const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId }, select: { installationId: true } })
        if (agent.installationId) {
          const workspace = await tx.githubInstallation.findFirst({
            where: { id: agent.installationId, orgId },
            select: { accountLogin: true }
          })
          if (workspace) {
            const next = await resolve(workspace.accountLogin)
            await tx.agent.update({ where: { id: agentId }, data: { installationId: next.id } })
          }
        }
        for (const grant of await tx.agentInstallationAuthorization.findMany({ where: { agentId } })) {
          const account = await accountOf(grant.installationId)
          if (!account) continue
          const next = await resolve(account)
          await tx.agentInstallationAuthorization.update({
            where: { id: grant.id },
            data: { installationId: next.installationId }
          })
        }
        for (const hook of await tx.hookDef.findMany({ where: { agentId, installationId: { not: null } } })) {
          const account = await accountOf(hook.installationId!)
          if (!account) continue
          const next = await resolve(account)
          await tx.hookDef.update({ where: { id: hook.id }, data: { installationId: next.installationId } })
        }
        // A watch is short-lived: one on an account the target App lacks keeps its installation rather than blocking.
        for (const watch of await tx.followUpWatch.findMany({ where: { agentId, installationId: { not: null } } })) {
          const account = await accountOf(watch.installationId!)
          if (!account) continue
          const next = await resolve(account).catch((e: unknown) => {
            if (e instanceof SwitchRefused) return null
            throw e
          })
          if (!next) continue
          await tx.followUpWatch.update({
            where: { agentId_followUpId: { agentId, followUpId: watch.followUpId } },
            data: { installationId: next.installationId }
          })
        }
      })
      return { ok: true }
    } catch (e) {
      if (e instanceof SwitchRefused) return { ok: false, ...e.refusal }
      if ((e as { code?: string }).code === 'P2002') return { ok: false, kind: 'app_in_use' }
      throw e
    }
  }

  async deleteFree(orgId: OrgId, id: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      // Only the App that created a Check can update it, so one with a Check still to close stays; NULL counts as unsettled.
      const unsettled = await tx.$queryRaw<Array<{ open: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "hook_review_projection" p
          JOIN "github_installation" i ON i."installationId" = p."lastResolvedInstallationId"
          WHERE i."githubAppId" = ${id}::uuid
            AND (
              p."tombstonedAt" IS NOT NULL
              AND p."writeMarker" IS NULL AND p."writePhase" IS NULL AND p."writeStartedAt" IS NULL
              AND p."pendingIntent" IS NULL AND p."leaseOwner" IS NULL AND p."leaseUntil" IS NULL
              AND p."nextAttemptAt" IS NULL
              AND p."desiredState" = 'failure'
              AND (
                p."observedState" = 'failure'
                OR (
                  p."observedState" = 'action_required'
                  AND p."subjectSyncGeneration" = p."generation"
                  AND p."subjectSyncErrorCode" IN (
                    'pr_association_incomplete', 'no_current_pull_request', 'stale_head', 'shared_head_multiple_prs'
                  )
                  AND p."lastErrorCode" = p."subjectSyncErrorCode"
                )
              )
            ) IS NOT TRUE
        ) AS "open"`
      if (unsettled[0]?.open) return false
      const res = await tx.githubApp.deleteMany({ where: { id, orgId, agent: { is: null } } })
      return res.count > 0
    })
  }
}

export class PgGithubAppSecretStore implements GithubAppSecretStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: OrgId, githubAppId: string, privateKeyB64: string, webhookSecret?: string): Promise<void> {
    if ((await this.prisma.githubApp.count({ where: { id: githubAppId, orgId } })) === 0) {
      throw new Error('github app secret write outside its organization')
    }
    const sealed = await this.cipher.seal(privateKeyB64, orgScope(orgId))
    const sealedWebhook = webhookSecret ? await this.cipher.seal(webhookSecret, orgScope(orgId)) : null
    await this.prisma.githubAppSecret.upsert({
      where: { githubAppId },
      create: { githubAppId, privateKey: sealed, webhookSecret: sealedWebhook },
      update: { privateKey: sealed, webhookSecret: sealedWebhook }
    })
  }

  async listWebhooks(): Promise<GithubAppWebhook[]> {
    const rows = await this.prisma.githubAppSecret.findMany({
      where: { webhookSecret: { not: null } },
      select: { githubAppId: true, webhookSecret: true, app: { select: { appId: true, orgId: true } } },
      orderBy: { githubAppId: 'asc' }
    })
    return Promise.all(
      rows.map(async (row) => ({
        githubAppId: row.githubAppId,
        appId: row.app.appId,
        webhookSecret: await this.cipher.open(row.webhookSecret!, orgScope(OrgId(row.app.orgId)))
      }))
    )
  }

  async get(orgId: OrgId, githubAppId: string): Promise<string | null> {
    const row = await this.prisma.githubAppSecret.findFirst({ where: { githubAppId, app: { orgId } } })
    return row ? this.cipher.open(row.privateKey, orgScope(orgId)) : null
  }
}
