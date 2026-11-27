// Artifact share links (artifacts.md §8.3): mint and hash tokens and keep the rows; the caller decides who may act (§6.3).
import { createHmac, randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import type {
  ArtifactRecord,
  ArtifactShareAudience,
  ArtifactSharePageQuery,
  ArtifactShareRecord,
  ArtifactShareRepo
} from '../persistence/ports.js'

const TOKEN_BYTES = 32
// base64url of 32 bytes, without padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HASH_DOMAIN = 'agentconnect:artifact-share:v1\0'

/** The console page a share link opens; the web app serves it, and the token is the last segment. */
export const ARTIFACT_SHARE_PAGE_PREFIX = '/share/'

export function artifactShareLinkPath(token: string): string {
  return `${ARTIFACT_SHARE_PAGE_PREFIX}${token}`
}

/** Peppered, domain-separated HMAC so a share token can never be replayed as another kind of token. */
export class ArtifactShareCodec {
  constructor(private readonly pepper: string) {}

  mint(): { token: string; hash: string; displayTail: string } {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    return { token, hash: this.hashUnchecked(token), displayTail: `…${token.slice(-6)}` }
  }

  /** Null for anything this control plane could not have minted, so a malformed token never reaches the database. */
  hash(token: string): string | null {
    return TOKEN_RE.test(token) ? this.hashUnchecked(token) : null
  }

  private hashUnchecked(token: string): string {
    return createHmac('sha256', this.pepper).update(HASH_DOMAIN).update(token).digest('hex')
  }
}

export interface CreatedArtifactShare {
  share: ArtifactShareRecord
  /** Returned once at creation; only its hash is stored. */
  token: string
  linkPath: string
  /** Absolute when the console origin is known. */
  link?: string
}

export interface ArtifactShareServiceDeps {
  shares: ArtifactShareRepo
  codec: ArtifactShareCodec
  clock: Clock
  webAppUrl?: string
}

export class ArtifactShareService {
  constructor(private readonly deps: ArtifactShareServiceDeps) {}

  async create(input: {
    orgId: string
    artifactId: string
    revisionNumber: number
    audience: ArtifactShareAudience
    createdByIdentity: string
  }): Promise<CreatedArtifactShare> {
    const minted = this.deps.codec.mint()
    const share = await this.deps.shares.create({ ...input, tokenHash: minted.hash, displayTail: minted.displayTail })
    const linkPath = artifactShareLinkPath(minted.token)
    const base = this.deps.webAppUrl?.replace(/\/+$/, '')
    return { share, token: minted.token, linkPath, ...(base ? { link: `${base}${linkPath}` } : {}) }
  }

  listActive(orgId: string, artifactId: string): Promise<ArtifactShareRecord[]> {
    return this.deps.shares.listActive(orgId, artifactId)
  }

  get(orgId: string, artifactId: string, shareId: string): Promise<ArtifactShareRecord | null> {
    return this.deps.shares.get(orgId, artifactId, shareId)
  }

  /** The audiences of the given artifacts' active shares, one row per artifact and audience. */
  activeAudiences(orgId: string, artifactIds: readonly string[]) {
    return this.deps.shares.activeAudiences(orgId, artifactIds)
  }

  /** Every active share of one audience in the organization with its artifact, for moderation (artifacts.md §6.3). */
  listActiveInOrg(orgId: string, audience: ArtifactShareAudience, page: ArtifactSharePageQuery) {
    return this.deps.shares.listActiveInOrg(orgId, audience, page)
  }

  /** The link stays the same (D16); null when the share is gone or revoked. */
  setAudience(
    orgId: string,
    artifactId: string,
    shareId: string,
    audience: ArtifactShareAudience
  ): Promise<ArtifactShareRecord | null> {
    return this.deps.shares.setAudience(orgId, artifactId, shareId, audience)
  }

  /** Takes effect on the next read of the link; repeating it keeps the first revocation time. */
  revoke(orgId: string, artifactId: string, shareId: string): Promise<ArtifactShareRecord | null> {
    return this.deps.shares.revoke(orgId, artifactId, shareId, new Date(this.deps.clock.now()))
  }

  /** The share a token names, revoked or not, with its artifact; null for an unknown or malformed token. */
  async resolve(token: string): Promise<{ share: ArtifactShareRecord; artifact: ArtifactRecord } | null> {
    const hash = this.deps.codec.hash(token)
    return hash ? this.deps.shares.findByTokenHash(hash) : null
  }
}
