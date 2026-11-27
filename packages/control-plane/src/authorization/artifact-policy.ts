// Artifact audience and authority (docs/designs/artifacts.md §6, §7.2, §7.3); pure, the caller reads identities and provider decisions.
import type { SessionExternalAccessSnapshot, SessionVisibility, ViewCtx } from '../persistence/ports.js'
import { externalScopeIsAllowed } from './policy.js'

/** The audience-bearing fields of an artifact; `private` with no owner is organization owners only. */
export interface ArtifactAudience {
  orgId: string
  visibility: SessionVisibility
  ownerIdentity: string | null
  externalProvider: string | null
  externalScopeId: string | null
  editorsAgentId: string | null
}

/** A signed-in member of `orgId` asking about an artifact, with the inputs that need I/O already read. */
export interface ArtifactViewer {
  orgId: string
  principal: ViewCtx
  /** `user:<id>` plus the member's verified platform identities (session-visibility.md §2). */
  identitySet: ReadonlySet<string>
  /** The provider decision covering the artifact's scope; absent denies every `external` artifact. */
  externalAccess?: SessionExternalAccessSnapshot
  /** The agents the member can edit now (`editableAgentIdsOf`); absent leaves `editors` artifacts to organization owners. */
  editableAgentIds?: ReadonlySet<string>
}

export const ArtifactAction = {
  View: 'artifact.view',
  ShareOrg: 'artifact.share.org',
  SharePublic: 'artifact.share.public',
  Rename: 'artifact.rename',
  /** Between `private` and `org` only (artifacts.md §6.3). */
  ChangeAudience: 'artifact.audience.change',
  RevokeShare: 'artifact.share.revoke',
  Delete: 'artifact.delete'
} as const

export type ArtifactAction = (typeof ArtifactAction)[keyof typeof ArtifactAction]

/** Organization members in the audience (§6.3); no role widens `private`, `external` or a live `editors` audience. */
export function canViewArtifact(artifact: ArtifactAudience, viewer: ArtifactViewer): boolean {
  if (artifact.orgId !== viewer.orgId) return false
  switch (artifact.visibility) {
    case 'private':
      return artifact.ownerIdentity === null
        ? viewer.principal.role === 'owner'
        : viewer.identitySet.has(artifact.ownerIdentity)
    case 'org':
      return true
    case 'external':
      return externalScopeIsAllowed(artifact.externalProvider, artifact.externalScopeId, viewer.externalAccess)
    case 'editors':
      // An organization owner edits every agent, and is the whole audience once the recorded agent is gone (§6.2).
      return (
        viewer.principal.role === 'owner' ||
        (artifact.editorsAgentId !== null && viewer.editableAgentIds?.has(artifact.editorsAgentId) === true)
      )
  }
}

/** The owner is a member whose identity set holds `ownerIdentity`, whatever their role (§6.1). */
export function isArtifactOwner(artifact: Pick<ArtifactAudience, 'ownerIdentity'>, identitySet: ReadonlySet<string>) {
  return artifact.ownerIdentity !== null && identitySet.has(artifact.ownerIdentity)
}

/** §6.3: organization owners widen, share publicly and rename only what they can view, and revoke or delete anything. */
export function canActOnArtifact(action: ArtifactAction, artifact: ArtifactAudience, viewer: ArtifactViewer): boolean {
  if (artifact.orgId !== viewer.orgId) return false
  const owner = isArtifactOwner(artifact, viewer.identitySet)
  const orgOwner = viewer.principal.role === 'owner'
  switch (action) {
    case ArtifactAction.View:
    case ArtifactAction.ShareOrg:
      return canViewArtifact(artifact, viewer)
    case ArtifactAction.SharePublic:
    case ArtifactAction.Rename:
      return owner || (orgOwner && canViewArtifact(artifact, viewer))
    case ArtifactAction.ChangeAudience:
      return (
        (artifact.visibility === 'private' || artifact.visibility === 'org') &&
        (owner || (orgOwner && canViewArtifact(artifact, viewer)))
      )
    case ArtifactAction.RevokeShare:
    case ArtifactAction.Delete:
      return owner || orgOwner
  }
}

/** §6.3: whoever may revoke any of the artifact's shares, or the member who created this one, since revoking only narrows access. */
export function canRevokeArtifactShare(
  artifact: ArtifactAudience,
  share: { createdByIdentity: string },
  viewer: ArtifactViewer
): boolean {
  if (artifact.orgId !== viewer.orgId) return false
  return (
    canActOnArtifact(ArtifactAction.RevokeShare, artifact, viewer) || viewer.identitySet.has(share.createdByIdentity)
  )
}

/** The session an agent is acting in, as far as its reach is concerned. */
export interface ArtifactReachSession {
  orgId: string
  agentId: string
  visibility: SessionVisibility
  externalProvider: string | null
  externalScopeId: string | null
  externalResolution: 'pending' | 'settled' | 'invalid' | null
}

/** §7.2: an agent sees only what the session's whole audience may see; `sessionOwner` is a private session's owner as a member. */
export function agentCanReachArtifact(
  artifact: ArtifactAudience,
  session: ArtifactReachSession,
  sessionOwner?: ArtifactViewer
): boolean {
  if (artifact.orgId !== session.orgId) return false
  switch (session.visibility) {
    case 'private':
      return (
        sessionOwner !== undefined && sessionOwner.orgId === session.orgId && canViewArtifact(artifact, sessionOwner)
      )
    case 'org':
      return artifact.visibility === 'org'
    case 'editors':
      return (
        artifact.visibility === 'org' ||
        (artifact.visibility === 'editors' && artifact.editorsAgentId === session.agentId)
      )
    case 'external':
      return (
        session.externalResolution === 'settled' &&
        session.externalProvider !== null &&
        session.externalScopeId !== null &&
        artifact.visibility === 'external' &&
        artifact.externalProvider === session.externalProvider &&
        artifact.externalScopeId === session.externalScopeId
      )
  }
}

/** The session row an artifact is created from. */
export interface ArtifactOriginSession extends ArtifactReachSession {
  ownerIdentity: string | null
}

/** Who started the publishing turn, resolved by the caller (§6.1, §7.3). */
export type ArtifactInitiator =
  /** A signed-in console user or a linked platform identity that resolves to this organization member. */
  | { kind: 'member'; userId: string }
  /** A guest, an unlinked sender, another agent, or no identity at all: provenance only. */
  | { kind: 'nonMember' }
  /** A cron or hook run; `headless` when it has no target conversation. */
  | { kind: 'trigger'; createdByUserId: string | null; headless: boolean }

/** §6.1: the owner and the audience copied from the session at creation; it never follows the session afterwards (§6.2). */
export function artifactAudienceFromSession(
  session: ArtifactOriginSession,
  initiator: ArtifactInitiator
): ArtifactAudience {
  const base = { orgId: session.orgId, externalProvider: null, externalScopeId: null, editorsAgentId: null }
  if (initiator.kind === 'trigger' && initiator.headless) {
    // No conversation to copy: private to the creator, or organization owners only when the creator is unknown.
    const ownerIdentity = initiator.createdByUserId === null ? null : `user:${initiator.createdByUserId}`
    return { ...base, visibility: 'private', ownerIdentity }
  }
  if (session.visibility === 'private') return { ...base, visibility: 'private', ownerIdentity: session.ownerIdentity }
  // An `editors` session's owner identity is someone outside the organization, so it is provenance only.
  if (session.visibility === 'editors') {
    return { ...base, visibility: 'editors', ownerIdentity: null, editorsAgentId: session.agentId }
  }
  const ownerIdentity =
    initiator.kind === 'member'
      ? `user:${initiator.userId}`
      : initiator.kind === 'trigger' && initiator.createdByUserId !== null
        ? `user:${initiator.createdByUserId}`
        : null
  if (session.visibility === 'org') return { ...base, visibility: 'org', ownerIdentity }
  if (session.externalResolution === 'settled' && session.externalProvider && session.externalScopeId) {
    return {
      ...base,
      visibility: 'external',
      ownerIdentity,
      externalProvider: session.externalProvider,
      externalScopeId: session.externalScopeId
    }
  }
  // An unresolved external session has no audience to copy: private to the owner, else organization owners only.
  return { ...base, visibility: 'private', ownerIdentity }
}
