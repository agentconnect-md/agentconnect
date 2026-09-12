/**
 * The control plane's **code-host provider contract**
 * (gitlab-com-integration.md §6.5, gitea-integration.md §13.5/§13.8).
 *
 * Code hosts are not chat platforms: they have no bot connection, no chat
 * ingress, no read port and no wizard identity, so they do not adopt the
 * four-contract platform-module shape. What the two hosts share is narrower, and
 * every member below is here because BOTH providers implement it today — the
 * same "extracted at the moment of the second implementer" rule the daemon's
 * turn-final surface and the relay's ingress contract followed. The shape that
 * earned the extraction is the two-way `kind === 'gitlab' ? … : …` ternary, which
 * a third host turns into a `switch` in core code.
 *
 * WHAT STAYS OUT, on purpose (§6.5, §13):
 *  - the bot identity and claim lifecycle — a GitHub App installation versus a
 *    per-project binding with per-agent service accounts (`provisionAgentAccount`
 *    brackets in the agent and hook writes have no GitHub counterpart at all);
 *  - webhook-secret distribution and credential minting (one deployment-wide App
 *    secret versus a per-binding signing token; App JWTs versus OAuth);
 *  - GitHub-only product surfaces (the workflow-approval start path, the session
 *    merge-request panel);
 *  - the per-provider spec host field (`gitlabHost`): both hosts' instance axes
 *    are one-axis values with a default, and a table of hosts would be guessing
 *    at a multi-instance design that does not exist yet. A provider reads its own
 *    field through {@link CodeHostProviderFeatures.specHost}.
 *  - the base-URL immutability lock's STATE COUNT, which lives in
 *    `persistence/repositories/deployment-config.repo.ts` keyed by provider:
 *    Prisma models are persistence's knowledge, not a provider module's.
 *
 * THE INSTANCE MODEL. An entry is a stateless strategy object: everything it
 * needs at call time arrives as an argument, so the registry is a plain record
 * and not a late-bound façade. `container.ts` publishes it on `HttpDeps` for the
 * routes; the pure projections no container reaches (the DTO and wire arms, the
 * feature predicates) read the same record through `codehost/registry.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type {
  AgentSpec,
  AgentWorkspaceCredential as SpecWorkspaceCredential,
  CodeHostHookRule,
  CodeHostProvider
} from '@agentconnect.md/protocol'
import type {
  AgentRecord,
  AgentRepoAuthorizationRecord,
  AgentWorkspaceCredential,
  HookRecord,
  RepoAccess
} from '../persistence/ports.js'
import type { AgentRepoAuthDtoT, AgentWorkspaceCredentialDtoT } from '../http/dto/index.js'
import type { HttpDeps } from '../http/deps.js'
import type { OrgId } from '../domain/ids.js'

/** The bundle a provider member reads its deployment's own services from. */
export type CodeHostDeps = HttpDeps

/** The effect axes a code-host hook write proposes; an axis this host has no surface for is absent. */
export interface CodeHostHookEffectBody {
  reviewPolicy?: HookRecord['reviewPolicy']
  reportingMode?: HookRecord['reportingMode']
  gateMode?: HookRecord['gateMode']
}

/** The same axes, resolved — a host without a surface for one reads its inert default. */
export interface CodeHostHookEffects {
  reviewPolicy: HookRecord['reviewPolicy']
  reportingMode: HookRecord['reportingMode']
  gateMode: HookRecord['gateMode']
}

/** The derived provenance of one cloneable address, for the acting caller (git-workspace-model.md §6). */
export type DerivedWorkspace =
  | {
      kind: 'github'
      /** The covering live installation (provenance hint persisted on the row). */
      installationId: string
      repoId: bigint
      gitRepo: string // canonical address from the installation lookup, never caller input
      defaultBranch: string
      access: 'read' | 'write'
    }
  | {
      kind: 'gitlab'
      projectId: bigint
      gitRepo: string // the catalog row's provider-authored clone URL (§24.1)
      defaultBranch: string
      access: 'read' | 'write'
    }
  | {
      kind: 'gitea'
      repoId: bigint
      gitRepo: string // the catalog row's provider-authored clone URL (gitea-integration.md §6)
      defaultBranch: string
      access: 'read' | 'write'
    }
  | {
      kind: 'anonymous'
      gitRepo: string
      defaultBranch?: string
      access: 'read'
      /** Which managed host the anonymous target sits on, for display derivation (§7). */
      host: CodeHostProvider | 'other'
    }

/** Actionable refusal (§6 table) — the routes answer it as a 409. */
export class WorkspaceCredentialRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceCredentialRefused'
  }
}

/** Throw the §6 table's refusal for an address this host owns. */
export function refuseWorkspaceCredential(message: string): never {
  throw new WorkspaceCredentialRefused(message)
}

/** One derivation attempt: provenance from the address, eligibility from the acting caller. */
export interface CodeHostWorkspaceDerivation {
  deps: CodeHostDeps
  orgId: string
  /** Absent ⇒ actorless caller; a configured identity gate fails CLOSED on one. */
  actorUserId?: string
  gitRepo: string
  /** Unstated ⇒ the highest tier the target carries. */
  requestedAccess?: 'read' | 'write'
  /** True when the caller persists the outcome: a host that binds on first use binds HERE (gitea-integration.md §6); a preview never writes. */
  write?: boolean
}

/** The persisted workspace fields one of this host's derivations writes. */
export interface CodeHostWorkspaceWrite {
  credential: AgentWorkspaceCredential
  workspaceRepoId: bigint
}

/** The host-shaped fields the legacy (pre-`workspace-git-v1`) spec arms share. */
export interface LegacySpecWorkspaceShared {
  isolation: Extract<AgentSpec['workspace'], { mode: 'git' }>['isolation']
  gitRepo: string
  branch: string
  agentDir?: string
  additionalRepos: Extract<AgentSpec['workspace'], { mode: 'git' }>['additionalRepos']
}

/** A projected spec, read for the §24.4 instance axis its host put there. */
export interface CodeHostShapedSpec {
  gitlabHost?: string
  giteaHost?: string
}

/** The route context an additional-repository grant mutation runs in. */
export interface CodeHostRepoAuthorizationContext {
  deps: CodeHostDeps
  req: FastifyRequest
  reply: FastifyReply
  /** The caller's active organization, resolved by the route. */
  orgId: OrgId
  agent: AgentRecord
  /** The grant row being raised; `row.provider` is what selected this entry. */
  row: AgentRepoAuthorizationRecord
  /** The tier the caller asked for — already checked to be strictly stronger. */
  access: RepoAccess
  /** The route's shared grant projection, so both arms answer one body shape. */
  toDto(row: AgentRepoAuthorizationRecord): AgentRepoAuthDtoT
}

/** §17.3/§24.4 feature negotiation for values this host shapes. */
export interface CodeHostProviderFeatures {
  /** The instance axis this deployment configures for this host, if it has one. */
  deploymentHost(deps: CodeHostDeps): string | undefined
  /** The instance axis a projected spec carries for this host, if it carries one. */
  specHost(spec: CodeHostShapedSpec): string | undefined
  /** The instance axis a compiled hook rule carries for this host, if it carries one. */
  ruleHost(rule: CodeHostHookRule): string | undefined
  /** Features a peer must advertise before a value this host shaped on `host` can decode there. */
  required(host: string | undefined): readonly string[]
  /** The §24.4 addition ALONE — for a gate that must not start requiring §17.3's bit as well. */
  requiredForInstance(host: string | undefined): readonly string[]
}

/** The workspace-provenance arms, one per host (git-workspace-model.md §5/§6). */
export interface CodeHostProviderWorkspace {
  /** Derive provenance for an address this host owns; null ⇒ the address is not its. */
  derive(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null>
  /** The persisted credential + numeric repo id one of this host's derivations writes; null ⇒ not its derivation. */
  writeFromDerived(derived: DerivedWorkspace): CodeHostWorkspaceWrite | null
  /** The read DTO of a persisted credential of this host; null ⇒ not its credential. */
  toDto(credential: AgentWorkspaceCredential, workspaceRepoId?: bigint): AgentWorkspaceCredentialDtoT | null
  /** The wire credential of a persisted credential of this host; null ⇒ not its credential. */
  toSpec(credential: AgentWorkspaceCredential, workspaceRepoId?: bigint): SpecWorkspaceCredential | null
  /** This host's legacy spec arm for a peer without `workspace-git-v1`; null ⇒ it has no arm of its own. */
  legacySpecArm(shared: LegacySpecWorkspaceShared, credential: SpecWorkspaceCredential): AgentSpec['workspace'] | null
}

/** The code-host hook axes and the convergence a hook write owes this host. */
export interface CodeHostProviderHooks {
  /** The effect axes this host's hook body carries, with its inert defaults for the axes it lacks. */
  effects(body: CodeHostHookEffectBody): CodeHostHookEffects
  /**
   * Re-converge this host's managed ingress for one repository after a hook or
   * grant write. A no-op where the host's webhook is deployment-wide (a GitHub
   * App delivers for every covered repository, so no write can change it).
   * Fire-and-forget: `onError` reports, and the convergence never fails CRUD.
   */
  convergeManagedRepository(
    deps: CodeHostDeps,
    orgId: OrgId,
    repoId: bigint | null,
    onError: (err: unknown) => void
  ): void
}

/** One code host's control-plane module. */
export interface CodeHostProviderModule {
  readonly provider: CodeHostProvider
  /** How operator-facing refusals name this host. */
  readonly displayName: string
  /** What this host calls one of its repositories, for refusals that name the subject. */
  readonly repositorySubject: string
  readonly features: CodeHostProviderFeatures
  readonly workspace: CodeHostProviderWorkspace
  readonly hooks: CodeHostProviderHooks
  /** Raise one additional-repository grant to a stronger tier (§8.3). */
  upgradeRepoAuthorization(ctx: CodeHostRepoAuthorizationContext): Promise<AgentRepoAuthDtoT | undefined>
}

/**
 * The provider set, keyed by provider. A `Record` and not a lookup façade: every
 * `Record<CodeHostProvider, …>` over it stops type-checking until a new host is
 * given an entry, which is what makes adding one a compile-time event instead of
 * a silently-inherited default.
 */
export type CodeHostProviderRegistry = Readonly<Record<CodeHostProvider, CodeHostProviderModule>>
