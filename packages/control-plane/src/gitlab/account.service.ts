/**
 * Per-agent GitLab runtime identity (gitlab-com-integration.md §7.2–§7.4,
 * §19.4): one group service account per (organization, agent, top-level group),
 * its project memberships, and the purpose-separated PATs it issues.
 *
 * Every account and PAT mutation — create, recover, rotate, display-name sync,
 * retire — runs under the ACCOUNT's own mutation lease, never a binding's; the
 * binding lease keeps owning membership and webhook work. Membership writers do
 * not take the account lease, so retirement cannot rely on rechecking emptiness:
 * a membership insert commits only against the row's current `active`
 * generation, while retirement compare-and-swaps `active`→`retiring` in the same
 * transaction that verifies the membership set is empty. A bind that loses that
 * race sees `retiring`, waits out the lease, and re-provisions a fresh generation.
 *
 * NEVER log token material or upstream token responses.
 */
import { randomBytes } from 'node:crypto'
import { AgentId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import type {
  AgentRecord,
  AgentRepo,
  GitlabAccountConsumer,
  GitlabAgentAccountRecord,
  GitlabAgentAccountRepo,
  GitlabCredentialPurpose,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore
} from '../persistence/ports.js'
import {
  GitlabApiError,
  gitlabAccountUsernameMatchesScheme,
  gitlabAgentAccountDisplayName,
  gitlabAgentAccountUsername,
  gitlabCreateServiceAccount,
  gitlabCreateServiceAccountToken,
  gitlabDeleteServiceAccount,
  gitlabEnsureMember,
  gitlabFindServiceAccount,
  gitlabListServiceAccountTokens,
  gitlabListServiceAccounts,
  gitlabRemoveMember,
  gitlabRevokeServiceAccountToken,
  gitlabUpdateServiceAccount,
  type FetchLike,
  type GitlabServiceAccount
} from './api.js'
import { GitlabEffectBroker, type GitlabEffectOutcome } from './effect-broker.js'
import type { GitlabOauthService } from './oauth.service.js'

/** The exclusive account lease a run holds across its provider writes. */
export const ACCOUNT_LEASE_MS = 5 * 60 * 1000

/** §7.3 v1 policy: every PAT is created with exactly this lifetime. */
export const PAT_LIFETIME_DAYS = 90

/** How long a recorded create window can still claim an account (§7.2). Bounded
 *  so a window left open by a dead process cannot adopt one created much later. */
export const CREATE_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000

const PURPOSE_SCOPES: Record<GitlabCredentialPurpose, string[]> = {
  read: ['read_api', 'read_repository'],
  git_write: ['write_repository'],
  effect: ['api']
}

const PURPOSES: readonly GitlabCredentialPurpose[] = ['read', 'git_write', 'effect']

/** §7.3: the provider returned a token outside the requested policy. */
export class GitlabTokenPolicyViolation extends Error {
  constructor(readonly purpose: GitlabCredentialPurpose) {
    super(`gitlab returned an out-of-policy ${purpose} token`)
    this.name = 'GitlabTokenPolicyViolation'
  }
}

/** The account lease was lost mid-run; the next converge resumes. */
export class GitlabAccountLeaseLost extends Error {
  constructor() {
    super('the gitlab account mutation lease was lost')
    this.name = 'GitlabAccountLeaseLost'
  }
}

/** An account the write could not provision, said the way a console can act on
 *  it. The reasons are this module's own repair categories (§8.2). */
export function gitlabAccountUnavailableMessage(reason: string): string {
  if (reason === 'service_account_quota') {
    return 'the GitLab group has no service-account slots left — free one, then try again'
  }
  if (reason === 'username_taken') {
    return 'another GitLab account already holds the bot username — remove or rename it, then try again'
  }
  if (reason === 'service_account_create_forbidden') {
    return 'the connected GitLab account must be an Owner of the top-level group to create bot accounts'
  }
  if (reason === 'provisioning_or_cleanup_in_progress' || reason === 'account_busy') {
    return 'GitLab project setup is already running — try again shortly'
  }
  return `the agent’s GitLab bot account could not be provisioned (${reason})`
}

function expiresAtDate(nowMs: number): string {
  return new Date(nowMs + PAT_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function patName(username: string, purpose: GitlabCredentialPurpose): string {
  return `${username}-${purpose.replace('_', '-')}`
}

/** §7.2: a top-level group refusing a creation for its 100-account quota is a
 *  different repair from an authority refusal, so the Console can say which. */
function refusalReason(e: unknown): string {
  if (!(e instanceof GitlabApiError)) return 'service_account_create_failed'
  if (/quota|limit|maximum/i.test(e.message)) return 'service_account_quota'
  return e.status === 403 || e.status === 401
    ? 'service_account_create_forbidden'
    : `gitlab_${e.status || 'unreachable'}`
}

export interface GitlabAccountServiceDeps {
  oauth: GitlabOauthService
  accounts: GitlabAgentAccountRepo
  credentials: GitlabProjectCredentialRepo
  credentialSecrets: GitlabProjectCredentialSecretStore
  agents: Pick<AgentRepo, 'getUnscoped'>
  cipher: SecretCipher
  clock: Clock
  /** Renders the agent's icon as the PNG its account wears (§7.2). Absent ⇒ the
   *  avatar is simply never converged; nothing else changes. */
  avatarPng?: (agent: Pick<AgentRecord, 'id' | 'icon' | 'runtime'>) => Promise<Uint8Array>
  fetchImpl?: FetchLike
  log?: { warn(obj: object, msg: string): void }
}

/** The account's avatar identity: exactly what the rendered PNG depends on, so
 *  an agent rename never re-uploads the same image (§7.2). */
export function gitlabAccountAvatarFingerprint(agent: Pick<AgentRecord, 'icon' | 'runtime'>): string {
  const icon = agent.icon
  if (icon?.kind === 'glyph') return `glyph:${icon.glyph}:${icon.color}`
  if (icon?.kind === 'image') return `image:${icon.generation ?? 'legacy'}`
  return `runtime:${agent.runtime ?? ''}`
}

/** One agent's converged identity on one project, or why it is not usable yet. */
export type AccountConvergeOutcome =
  { ok: true; account: GitlabAgentAccountRecord } | { ok: false; reason: string; retryable: boolean }

export class GitlabAccountService {
  /** §7.3: the only holder of effect-token material in the Control Plane. Built
   *  here, never injected, so no other collaborator can reach an `api` PAT. */
  private readonly effects: GitlabEffectBroker

  constructor(private readonly deps: GitlabAccountServiceDeps) {
    this.effects = new GitlabEffectBroker({
      credentials: deps.credentials,
      credentialSecrets: deps.credentialSecrets,
      clock: deps.clock,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
    })
  }

  /**
   * Converge the accounts of one binding's agent consumers (§10.2 steps 2–5)
   * and reconcile its membership set: every consumer gains a member account at
   * the role its authorization derives, and an account whose last consumer went
   * away loses the membership and — with nothing left in its root — retires.
   * Runs under the caller's binding lease; each account mutation takes its own.
   */
  async convergeForBinding(input: {
    orgId: string
    bindingId: string
    projectId: bigint
    rootGroupId: number
    installerConnectionId: string
    token: string
  }): Promise<{ reason: string | null; retryable: boolean }> {
    const consumers = await this.deps.accounts.consumers(input.orgId, input.projectId)
    let reason: string | null = null
    // A contended account lease or a lost generation fence resolves on its own:
    // the caller must come back rather than leave the agent unbound (§7.2).
    let retryable = false
    const fail = (why: string, again: boolean): void => {
      if (reason !== null) return
      reason = why
      retryable = again
    }
    // Keyed by AGENT, not by converged account: only the authorization set says
    // who may stay bound, so a transient convergence failure never revokes one.
    const authorized = new Set(consumers.map((consumer) => consumer.agentId))
    for (const consumer of consumers) {
      const outcome = await this.ensureForConsumer(input, consumer)
      if (!outcome.ok) fail(outcome.reason, outcome.retryable)
    }
    // Authorization removed ⇒ membership removed (§7.2). The account itself
    // survives while it still serves another project in its root.
    for (const membership of await this.deps.accounts.membershipsForBinding(input.bindingId)) {
      const account = await this.deps.accounts.get(membership.accountId)
      if (!account || authorized.has(account.agentId)) continue
      try {
        await this.unbindOne(input.orgId, account, input.bindingId, input.projectId, input.token)
      } catch (e) {
        this.deps.log?.warn(
          { accountId: account.id, status: e instanceof GitlabApiError ? e.status : undefined },
          'gitlab account membership removal failed'
        )
        fail('account_unbind_failed', false)
      }
    }
    return { reason, retryable }
  }

  /**
   * ONE consuming agent's identity on one project: its account, its three PATs,
   * and its project membership at the derived role.
   *
   * Public because a write that will immediately act as that agent — a gitlab
   * workspace edit whose activation mints credentials, a hook whose rule must
   * carry an account — has to run this to completion BEFORE it dispatches,
   * while the row that would make the agent a consumer does not exist yet.
   * The binding converge is the same call per consumer it already has.
   */
  async ensureForConsumer(
    input: {
      orgId: string
      bindingId: string
      projectId: bigint
      rootGroupId: number
      installerConnectionId: string
      token: string
    },
    consumer: GitlabAccountConsumer
  ): Promise<{ ok: true } | { ok: false; reason: string; retryable: boolean }> {
    const outcome = await this.ensureAccount(input, consumer)
    // A contended account lease resolves itself; every other refusal is the
    // account's own recorded state and needs a repair, not another attempt.
    if (!outcome.ok) return { ok: false, reason: outcome.reason, retryable: outcome.reason === 'account_busy' }
    if (!(await this.bindMembership(input, outcome.account, consumer.accessLevel))) {
      return { ok: false, reason: 'account_membership_contended', retryable: true }
    }
    return { ok: true }
  }

  /** One consumer's account: created or recovered in the root, named after the
   *  agent, and holding the three purpose-separated PATs. */
  private async ensureAccount(
    input: { orgId: string; rootGroupId: number; installerConnectionId: string; token: string },
    consumer: GitlabAccountConsumer
  ): Promise<AccountConvergeOutcome> {
    const agent = await this.deps.agents.getUnscoped(AgentId(consumer.agentId))
    if (!agent) return { ok: false, reason: 'agent_missing', retryable: false }
    const rootGroupId = BigInt(input.rootGroupId)
    const agentName = agent.displayName ?? agent.name
    // The derivation names a NEW account only: an existing row's username is its
    // own creation-time fact, and the numeric user id is the durable key (§7.2).
    const derived = gitlabAgentAccountUsername(consumer.agentId, agentName, rootGroupId)
    let account = await this.deps.accounts.ensure({
      orgId: input.orgId,
      agentId: consumer.agentId,
      rootGroupId,
      username: derived,
      administeringConnectionId: input.installerConnectionId
    })
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.accounts.claimLease(account.id, owner, new Date(nowMs + ACCOUNT_LEASE_MS), new Date(nowMs)))
    ) {
      // A live peer owns this account: nothing is written and the next converge retries.
      return { ok: false, reason: 'account_busy', retryable: true }
    }
    try {
      if (account.lifecycle === 'retiring') {
        // The retirement released its lease, so it is over — re-provision a
        // fresh generation rather than reviving the one it was tearing down.
        account = (await this.deps.accounts.reactivate(account.id)) ?? account
      }
      const displayName = gitlabAgentAccountDisplayName(agentName, account.username)
      // This top-level group's OWN accounts — never a global user search (§7.2).
      let listing = await gitlabListServiceAccounts(input.token, input.rootGroupId, this.deps.fetchImpl)
      // The durable key first: an account we already recorded needs no marker.
      let external =
        (account.serviceAccountUserId === null
          ? undefined
          : listing.find((candidate) => BigInt(candidate.id) === account.serviceAccountUserId)) ?? null
      // A create that was recorded but never committed may have landed anyway —
      // an interrupted attempt is recovered from its PERSISTED window alone.
      if (!external) external = this.claimFromAttempt(account, listing)
      if (!external) {
        const taken = listing.find((candidate) => candidate.username === account.username)
        if (taken) {
          // Held by an account no open window of ours covers: it is somebody
          // else's, and adopting it would hand them this agent's credentials.
          await this.deps.accounts.update(account.id, { state: 'admin_degraded', stateReason: 'username_taken' })
          return { ok: false, reason: 'username_taken', retryable: false }
        }
        // Record-first: the window is committed BEFORE the provider write, so it
        // survives a lost lease and a process that dies mid-create.
        account =
          (await this.deps.accounts.openCreateAttempt({
            accountId: account.id,
            attemptId: randomBytes(9).toString('base64url'),
            openedAt: new Date(this.deps.clock.now()),
            knownServiceAccountUserIds: listing.map((candidate) => BigInt(candidate.id))
          })) ?? account
        try {
          external = await gitlabCreateServiceAccount(
            input.token,
            input.rootGroupId,
            { username: account.username, name: displayName },
            this.deps.fetchImpl
          )
        } catch (e) {
          // Ambiguous create: re-read, then apply that same persisted window.
          listing = await gitlabListServiceAccounts(input.token, input.rootGroupId, this.deps.fetchImpl)
          external = this.claimFromAttempt(account, listing)
          if (!external) {
            const reason = listing.some((candidate) => candidate.username === account.username)
              ? 'username_taken'
              : refusalReason(e)
            await this.deps.accounts.update(account.id, { state: 'admin_degraded', stateReason: reason })
            return { ok: false, reason, retryable: reason !== 'username_taken' }
          }
        }
      }
      // Resolved — the recovery window has done its job and closes.
      await this.deps.accounts.closeCreateAttempt(account.id)
      // Cosmetic username convergence (§7.2): an account whose username predates
      // the readable scheme is renamed once. The slug half is creation-time, so
      // only the shape and the key suffix decide — a later agent rename is not a
      // reason to rename the account. A refusal leaves the durable key untouched.
      if (!gitlabAccountUsernameMatchesScheme(external.username, consumer.agentId, rootGroupId)) {
        try {
          external = await gitlabUpdateServiceAccount(
            input.token,
            input.rootGroupId,
            BigInt(external.id),
            { username: derived },
            this.deps.fetchImpl
          )
        } catch (e) {
          this.deps.log?.warn(
            { accountId: account.id, status: e instanceof GitlabApiError ? e.status : undefined },
            'gitlab service account username convergence failed'
          )
        }
      }
      // A refused rename is cosmetic: the account and its credentials matter,
      // its label does not, so the fingerprint simply stays behind (§7.2).
      if (external.name !== displayName) {
        try {
          external = await gitlabUpdateServiceAccount(
            input.token,
            input.rootGroupId,
            BigInt(external.id),
            { name: displayName },
            this.deps.fetchImpl
          )
        } catch (e) {
          this.deps.log?.warn(
            { accountId: account.id, status: e instanceof GitlabApiError ? e.status : undefined },
            'gitlab service account rename failed'
          )
        }
      }
      const serviceAccountUserId = BigInt(external.id)
      account =
        (await this.deps.accounts.update(account.id, {
          serviceAccountUserId,
          // The provider's own answer, so a refused rename keeps the old name.
          username: external.username,
          displayName: external.name === displayName ? displayName : account.displayName,
          administeringConnectionId: input.installerConnectionId
        })) ?? account
      for (const purpose of PURPOSES) {
        const existing = await this.deps.credentials.get(account.id, purpose)
        const stillValid =
          existing &&
          existing.providerExpiresAt.getTime() > this.deps.clock.now() &&
          (await this.deps.credentialSecrets.get(input.orgId, existing.id)) !== null
        if (stillValid) continue
        await this.mintCredential(
          input.orgId,
          account,
          input.token,
          input.rootGroupId,
          serviceAccountUserId,
          purpose,
          owner
        )
      }
      account = await this.convergeAvatar(input.orgId, account, agent)
      account = (await this.deps.accounts.update(account.id, { state: 'ready', stateReason: null })) ?? account
      return { ok: true, account }
    } catch (e) {
      const reason =
        e instanceof GitlabTokenPolicyViolation
          ? 'out_of_policy_token'
          : e instanceof GitlabAccountLeaseLost
            ? 'account_lease_lost'
            : e instanceof GitlabApiError
              ? `gitlab_${e.status || 'unreachable'}`
              : 'admin_unavailable'
      this.deps.log?.warn({ accountId: account.id, reason }, 'gitlab account provisioning failed')
      await this.deps.accounts.update(account.id, { state: 'admin_degraded', stateReason: reason })
      return { ok: false, reason, retryable: true }
    } finally {
      await this.deps.accounts.releaseLease(account.id, owner).catch(() => {})
    }
  }

  /**
   * §7.2 record-first recovery. An account holding this row's username is
   * claimed ONLY when the row's own persisted create window covers it: the
   * window is still open and not stale, the account is listed among this
   * top-level group's own service accounts, and it was absent when the window
   * opened. GitLab reports no creation time for a service account, so the
   * window's recorded membership snapshot is what dates the account — and
   * because it was committed before the provider write, it survives a lost
   * lease and a process that died between GitLab creating the account and the
   * row committing its numeric id. Anything else is a foreign account.
   */
  private claimFromAttempt(
    account: GitlabAgentAccountRecord,
    listing: readonly GitlabServiceAccount[]
  ): GitlabServiceAccount | null {
    const attempt = account.createAttempt
    if (!attempt) return null
    if (this.deps.clock.now() - attempt.openedAt.getTime() > CREATE_ATTEMPT_WINDOW_MS) return null
    const candidate = listing.find((entry) => entry.username === account.username)
    if (!candidate) return null
    return attempt.knownServiceAccountUserIds.includes(BigInt(candidate.id)) ? null : candidate
  }

  /**
   * §7.2: the agent's icon changed — reconverge the avatar of every account it
   * holds, each under that account's own mutation lease. Cosmetic end to end,
   * so a contended lease, a refusal, or an unsupported endpoint is dropped and
   * nothing here touches credentials. Never throws: callers fire and forget.
   */
  async syncAgentAvatars(orgId: string, agentId: string): Promise<void> {
    if (!this.deps.avatarPng) return
    try {
      const agent = await this.deps.agents.getUnscoped(AgentId(agentId))
      if (!agent) return
      for (const account of await this.deps.accounts.listForAgent(orgId, agentId)) {
        if (account.lifecycle !== 'active' || account.serviceAccountUserId === null) continue
        const owner = randomBytes(9).toString('base64url')
        const nowMs = this.deps.clock.now()
        const claimed = await this.deps.accounts.claimLease(
          account.id,
          owner,
          new Date(nowMs + ACCOUNT_LEASE_MS),
          new Date(nowMs)
        )
        if (!claimed) continue
        try {
          await this.convergeAvatar(orgId, account, agent)
        } finally {
          await this.deps.accounts.releaseLease(account.id, owner).catch(() => {})
        }
      }
    } catch (e) {
      this.deps.log?.warn({ agentId, err: e }, 'gitlab account avatar fan-out failed')
    }
  }

  /** §7.2 cosmetic avatar convergence, under the caller's account lease and
   *  through the §7.3 effect broker. Only a completed upload is recorded, so a
   *  skip simply retries on the next convergence; nothing degrades credentials. */
  private async convergeAvatar(
    orgId: string,
    account: GitlabAgentAccountRecord,
    agent: Pick<AgentRecord, 'id' | 'icon' | 'runtime'>
  ): Promise<GitlabAgentAccountRecord> {
    const render = this.deps.avatarPng
    if (!render || account.serviceAccountUserId === null) return account
    const fingerprint = gitlabAccountAvatarFingerprint(agent)
    if (account.avatarFingerprint === fingerprint) return account
    let outcome: GitlabEffectOutcome
    try {
      outcome = await this.effects.uploadAccountAvatar(orgId, account, await render(agent))
    } catch (e) {
      this.deps.log?.warn({ accountId: account.id, err: e }, 'gitlab account avatar render failed')
      return account
    }
    if (outcome !== 'done') {
      this.deps.log?.warn({ accountId: account.id, outcome }, 'gitlab account avatar upload skipped')
      return account
    }
    return (await this.deps.accounts.update(account.id, { avatarFingerprint: fingerprint })) ?? account
  }

  /** Project membership at the derived role, then the generation-fenced local
   *  row. A lost fence means a retirement committed first; the next converge
   *  re-provisions the account from a fresh generation. */
  private async bindMembership(
    input: { orgId: string; bindingId: string; projectId: bigint; token: string },
    account: GitlabAgentAccountRecord,
    accessLevel: number
  ): Promise<boolean> {
    if (account.serviceAccountUserId === null) return false
    await gitlabEnsureMember(
      input.token,
      input.projectId,
      account.serviceAccountUserId,
      accessLevel,
      this.deps.fetchImpl
    )
    return this.deps.accounts.attachMembership({
      accountId: account.id,
      generation: account.generation,
      bindingId: input.bindingId,
      accessLevel
    })
  }

  /** Remove one account's membership on one project, then retire it when its
   *  root holds no bound project any more (§19.4). */
  private async unbindOne(
    orgId: string,
    account: GitlabAgentAccountRecord,
    bindingId: string,
    projectId: bigint,
    token: string
  ): Promise<boolean> {
    if (account.serviceAccountUserId !== null) {
      await gitlabRemoveMember(token, projectId, account.serviceAccountUserId, this.deps.fetchImpl).catch(swallow404)
    }
    await this.deps.accounts.detachMembership(account.id, bindingId)
    return this.retireIfEmpty(orgId, account.id, token)
  }

  /**
   * Undo a speculative bind whose write never landed. `ensureForConsumer` runs
   * BEFORE the row that makes the agent a consumer exists, so a failure after it
   * can leave an account — and possibly a membership — that no convergence would
   * ever visit: the unbind pass discovers stale members through the binding's
   * membership rows, and an account with none is invisible to it. Left alone it
   * would sit in the root consuming one of its 100 service-account slots for a
   * hook or workspace that does not exist.
   *
   * An account still bound to another project keeps its membership and its PATs
   * (§19.4) — only the binding this write was for is undone.
   */
  async rollbackSpeculativeBind(
    input: { orgId: string; bindingId: string; projectId: bigint; rootGroupId: bigint; token: string },
    agentId: string
  ): Promise<void> {
    const account = await this.deps.accounts.byAgentRoot(input.orgId, agentId, input.rootGroupId)
    if (!account) return
    // Another authorization may already earn this membership — a workspace on
    // the project, or an enabled hook that is not the one being rolled back.
    // The consumer set is the same authority the unbind pass uses, so asking it
    // keeps this from revoking access the write never granted. It does not
    // justify the ROLE the write installed, though: a read-only workspace earns
    // Reporter, so a failed hook that raised the account to Developer must give
    // that back rather than leave write access behind indefinitely.
    const consumers = await this.deps.accounts.consumers(input.orgId, input.projectId)
    const surviving = consumers.find((consumer) => consumer.agentId === agentId)
    if (surviving) {
      try {
        if (account.serviceAccountUserId !== null) {
          await gitlabEnsureMember(
            input.token,
            input.projectId,
            account.serviceAccountUserId,
            surviving.accessLevel,
            this.deps.fetchImpl
          )
        }
        await this.deps.accounts.attachMembership({
          accountId: account.id,
          generation: account.generation,
          bindingId: input.bindingId,
          accessLevel: surviving.accessLevel
        })
      } catch (e) {
        this.deps.log?.warn(
          { accountId: account.id, status: e instanceof GitlabApiError ? e.status : undefined },
          'gitlab speculative role rollback failed'
        )
      }
      return
    }
    try {
      const bound = await this.deps.accounts.membershipsForBinding(input.bindingId)
      if (bound.some((membership) => membership.accountId === account.id)) {
        if (account.serviceAccountUserId !== null) {
          await gitlabRemoveMember(
            input.token,
            input.projectId,
            account.serviceAccountUserId,
            this.deps.fetchImpl
          ).catch(swallow404)
        }
        await this.deps.accounts.detachMembership(account.id, input.bindingId)
      }
      await this.retireIfEmpty(input.orgId, account.id, input.token)
    } catch (e) {
      // Best effort: the account row keeps its own cleanup state, and the next
      // convergence of any project in this root reconciles what is left.
      this.deps.log?.warn(
        { accountId: account.id, status: e instanceof GitlabApiError ? e.status : undefined },
        'gitlab speculative bind rollback failed'
      )
    }
  }

  /** §19.4: an account with no membership left in its root is retired — PATs
   *  revoked, account deleted — never kept warm. */
  async retireIfEmpty(orgId: string, accountId: string, token: string): Promise<boolean> {
    const account = await this.deps.accounts.get(accountId)
    if (!account) return true
    if ((await this.deps.accounts.countMemberships(accountId)) > 0) return true
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (!(await this.deps.accounts.claimLease(accountId, owner, new Date(nowMs + ACCOUNT_LEASE_MS), new Date(nowMs)))) {
      return false
    }
    try {
      // The CAS and the emptiness check are one transaction: a bind that landed
      // first keeps the account alive and this run withdraws (§7.2).
      if (!(await this.deps.accounts.beginRetirement(accountId))) return true
      if (account.serviceAccountUserId !== null) {
        const rootGroupId = Number(account.rootGroupId)
        for (const credential of await this.deps.credentials.listForAccount(accountId)) {
          await gitlabRevokeServiceAccountToken(
            token,
            rootGroupId,
            account.serviceAccountUserId,
            credential.externalTokenId,
            this.deps.fetchImpl
          ).catch(swallow404)
        }
        await gitlabDeleteServiceAccount(token, rootGroupId, account.serviceAccountUserId, this.deps.fetchImpl).catch(
          swallow404
        )
        // Release only on positive evidence: the deterministic marker is absent.
        if (await gitlabFindServiceAccount(token, rootGroupId, account.username, this.deps.fetchImpl)) {
          throw new GitlabApiError('marked service account still present after retirement', 0, 'INTERNAL', true)
        }
      }
      await this.deps.accounts.finishRetirement(accountId)
      return true
    } catch (e) {
      const reason = e instanceof GitlabApiError ? `gitlab_${e.status || 'unreachable'}` : 'cleanup_failed'
      this.deps.log?.warn({ accountId, reason }, 'gitlab account retirement failed')
      await this.deps.accounts.update(accountId, { state: 'cleanup_pending', stateReason: reason })
      return false
    } finally {
      await this.deps.accounts.releaseLease(accountId, owner).catch(() => {})
    }
  }

  /**
   * §19.4: deleting an agent retires every account it earned. Each account's own
   * administering connection does the external cleanup; without one the row
   * degrades to `cleanup_pending` and waits for a reconnect or a takeover.
   */
  async retireAgentAccounts(orgId: string, agentId: string): Promise<void> {
    for (const account of await this.deps.accounts.listForAgent(orgId, agentId)) {
      if (!account.administeringConnectionId) {
        await this.deps.accounts.update(account.id, { state: 'cleanup_pending', stateReason: 'no_admin_connection' })
        continue
      }
      try {
        const token = await this.deps.oauth.withAccessToken(orgId, account.administeringConnectionId)
        for (const membership of await this.deps.accounts.membershipsOfAccount(account.id)) {
          if (account.serviceAccountUserId !== null) {
            await gitlabRemoveMember(
              token,
              membership.projectId,
              account.serviceAccountUserId,
              this.deps.fetchImpl
            ).catch(swallow404)
          }
          await this.deps.accounts.detachMembership(account.id, membership.bindingId)
        }
        await this.retireIfEmpty(orgId, account.id, token)
      } catch (e) {
        const reason = e instanceof GitlabApiError ? `gitlab_${e.status || 'unreachable'}` : 'admin_unavailable'
        this.deps.log?.warn({ accountId: account.id, reason }, 'gitlab account retirement failed')
        await this.deps.accounts.update(account.id, { state: 'cleanup_pending', stateReason: reason })
      }
    }
  }

  /** Every account bound to a binding loses its membership (§19.4 disconnect);
   *  an account left with nothing bound in its root retires. True only when no
   *  membership survives AND every emptied account retired — the caller's
   *  positive evidence for releasing the deployment-global claim. */
  async unbindBinding(orgId: string, bindingId: string, projectId: bigint, token: string): Promise<boolean> {
    let clean = true
    for (const membership of await this.deps.accounts.membershipsForBinding(bindingId)) {
      const account = await this.deps.accounts.get(membership.accountId)
      if (account && !(await this.unbindOne(orgId, account, bindingId, projectId, token))) clean = false
    }
    return clean && (await this.deps.accounts.membershipsForBinding(bindingId)).length === 0
  }

  /**
   * §7.4 rotation: create the replacement BEFORE revoking the old PAT — GitLab's
   * rotate-in-place invalidates immediately, so the overlap lives on our side.
   * The rotated population is per-agent accounts, and each rotation runs under
   * the ACCOUNT's mutation lease, never a binding's.
   */
  async rotateDueCredentials(horizonMs: number): Promise<void> {
    const due = await this.deps.credentials.listExpiring(new Date(this.deps.clock.now() + horizonMs))
    const failed = new Set<string>()
    for (const { credential, orgId } of due) {
      if (failed.has(credential.accountId)) continue
      const account = await this.deps.accounts.get(credential.accountId)
      if (!account || account.lifecycle !== 'active' || account.state === 'cleanup_pending') continue
      if (!account.administeringConnectionId || account.serviceAccountUserId === null) {
        failed.add(account.id)
        await this.deps.accounts.update(account.id, {
          state: 'admin_degraded',
          stateReason: 'rotation_admin_unavailable'
        })
        continue
      }
      const owner = randomBytes(9).toString('base64url')
      const nowMs = this.deps.clock.now()
      if (
        !(await this.deps.accounts.claimLease(account.id, owner, new Date(nowMs + ACCOUNT_LEASE_MS), new Date(nowMs)))
      ) {
        continue
      }
      try {
        const token = await this.deps.oauth.withAccessToken(orgId, account.administeringConnectionId)
        // Revalidate UNDER the lease: the worklist is a pre-lease snapshot, so a
        // peer sweep may have rotated this row already. The reloaded predecessor
        // (never the snapshot's) is what gets revoked.
        const current = await this.deps.credentials.get(account.id, credential.purpose)
        if (
          !current ||
          current.generation !== credential.generation ||
          current.providerExpiresAt.getTime() >= this.deps.clock.now() + horizonMs
        ) {
          continue
        }
        const rootGroupId = Number(account.rootGroupId)
        const previousTokenId = current.externalTokenId
        await this.mintCredential(
          orgId,
          account,
          token,
          rootGroupId,
          account.serviceAccountUserId,
          credential.purpose,
          owner
        )
        await gitlabRevokeServiceAccountToken(
          token,
          rootGroupId,
          account.serviceAccountUserId,
          previousTokenId,
          this.deps.fetchImpl
        ).catch(() => {
          this.deps.log?.warn(
            { accountId: account.id, purpose: credential.purpose },
            'gitlab rotation could not revoke the previous token (it still expires on schedule)'
          )
        })
        // A rotation-owned degradation heals on the first successful rotation.
        if (account.state === 'admin_degraded' && account.stateReason?.startsWith('rotation_')) {
          await this.deps.accounts.update(account.id, { state: 'ready', stateReason: null })
        }
      } catch (e) {
        failed.add(account.id)
        // Every rotation-set reason is rotation_-prefixed: that namespace is
        // exactly what a later successful sweep may clear.
        const reason =
          e instanceof GitlabTokenPolicyViolation
            ? 'rotation_out_of_policy_token'
            : e instanceof GitlabAccountLeaseLost
              ? 'rotation_lease_lost'
              : e instanceof GitlabApiError
                ? `rotation_gitlab_${e.status || 'unreachable'}`
                : 'rotation_admin_unavailable'
        this.deps.log?.warn({ accountId: account.id, reason }, 'gitlab credential rotation failed')
        await this.deps.accounts.update(account.id, { state: 'admin_degraded', stateReason: reason })
      } finally {
        await this.deps.accounts.releaseLease(account.id, owner).catch(() => {})
      }
    }
  }

  /** One purpose-separated PAT, validated before sealing and committed atomically. */
  private async mintCredential(
    orgId: string,
    account: GitlabAgentAccountRecord,
    token: string,
    rootGroupId: number,
    serviceAccountUserId: bigint,
    purpose: GitlabCredentialPurpose,
    owner: string
  ): Promise<void> {
    const scopes = PURPOSE_SCOPES[purpose]
    const expiresAt = expiresAtDate(this.deps.clock.now())
    await this.renew(account.id, owner)
    // Ambiguous-create recovery (§10.2): a marked token we did not record has a
    // lost plaintext — revoke it before minting, sparing the recorded one
    // (rotation's create-before-revoke overlap shares the name deliberately).
    const recorded = await this.deps.credentials.get(account.id, purpose)
    const name = patName(account.username, purpose)
    const strays = (
      await gitlabListServiceAccountTokens(token, rootGroupId, serviceAccountUserId, this.deps.fetchImpl)
    ).filter((t) => t.name === name && t.active !== false && t.revoked !== true)
    for (const stray of strays) {
      if (recorded && BigInt(stray.id) === recorded.externalTokenId) continue
      await gitlabRevokeServiceAccountToken(
        token,
        rootGroupId,
        serviceAccountUserId,
        BigInt(stray.id),
        this.deps.fetchImpl
      ).catch(() =>
        this.deps.log?.warn({ accountId: account.id, purpose }, 'gitlab stray token revocation is unconfirmed')
      )
    }
    // Renew again right before the create: the stray sweep above may have spent
    // a chunk of the lease on sequential provider calls.
    await this.renew(account.id, owner)
    const grant = await gitlabCreateServiceAccountToken(
      token,
      rootGroupId,
      serviceAccountUserId,
      { name, scopes, expiresAt },
      this.deps.fetchImpl
    )
    // §7.3 validation before sealing: identity, scopes, active, EXACT expiry.
    const valid =
      typeof grant.token === 'string' &&
      grant.token.length > 0 &&
      grant.active !== false &&
      grant.revoked !== true &&
      grant.expires_at === expiresAt &&
      (grant.user_id === undefined || BigInt(grant.user_id) === serviceAccountUserId) &&
      scopes.every((scope) => grant.scopes?.includes(scope)) &&
      grant.scopes?.length === scopes.length
    if (!valid) {
      // Out-of-policy token: revoke by id immediately and fail closed. An
      // id-less response is recorded as restricted cleanup debt.
      if (typeof grant.id === 'number') {
        await gitlabRevokeServiceAccountToken(
          token,
          rootGroupId,
          serviceAccountUserId,
          BigInt(grant.id),
          this.deps.fetchImpl
        ).catch(() => {
          this.deps.log?.warn(
            { accountId: account.id, purpose, tokenId: grant.id },
            'gitlab out-of-policy token revocation is unconfirmed (restricted cleanup debt)'
          )
        })
      } else {
        this.deps.log?.warn({ accountId: account.id, purpose }, 'gitlab returned an out-of-policy token without an id')
      }
      throw new GitlabTokenPolicyViolation(purpose)
    }
    // Seal first; metadata, sealed value, and the epoch fence commit atomically.
    await this.deps.credentials.commitRotation({
      accountId: account.id,
      purpose,
      externalTokenId: BigInt(grant.id),
      scopes,
      providerExpiresAt: new Date(`${expiresAt}T00:00:00.000Z`),
      sealedToken: await this.deps.cipher.seal(grant.token!, orgScope(OrgId(orgId)))
    })
  }

  /** Per-step atomic renewal: the run must still own the account lease, and the
   *  extension covers the provider request that follows. */
  private async renew(accountId: string, owner: string): Promise<void> {
    const until = new Date(this.deps.clock.now() + ACCOUNT_LEASE_MS)
    if (!(await this.deps.accounts.renewLease(accountId, owner, until))) throw new GitlabAccountLeaseLost()
  }
}

/** A definitively absent external resource IS cleaned up; anything else rethrows. */
function swallow404(e: unknown): void {
  if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return
  throw e
}
