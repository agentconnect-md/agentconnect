// What a code host contributes to the credential proxy (azure-devops-integration.md §6.2): its instances and the credential each request needs, as a registered descriptor; the shared router names no provider.
import type { AzureDevOpsRepoRouting } from '@agentconnect.md/protocol'
import { stripHostPathPrefix, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'
import { isGitPush } from './github-route.js'

export { isGitPush }

/** One code-host instance an agent's credential reaches, as the proxy matches it. */
export interface ProxyInstance {
  provider: string
  /** What a placeholder is sealed for and TLS is terminated on: the host with a non-default port; GitHub's names on any port. */
  hosts: readonly string[]
  /** The instance's path prefix, without surrounding slashes; empty at the root. */
  pathPrefix: string
  /** A SaaS name, which never resolves into private space. */
  saas?: true
}

/** One of an agent's authorized repositories on a descriptor's provider, from its spec: the workspace's or an additional one. */
export interface ProxyRepository {
  /** The numeric identity a credential ask names. */
  repoId: string
  /** The spec's path label. */
  repoFullName: string
  /** The workspace repository, which a lease names by the workspace alone. */
  workspace?: true
  /** An Azure DevOps repository's organization, project and repository GUIDs. */
  azureDevOps?: AzureDevOpsRepoRouting
}

/** What a descriptor reads of the agent a request is for, and the request's headers where the router has them. */
export interface ProxyRouteContext {
  repositories: readonly ProxyRepository[]
  headers?: { has(name: string): boolean }
}

/** A repository a lease names: its path and, where the provider numbers it, its numeric id. */
export interface RepositoryRef {
  repo: string
  repoId: string
}

export type InstanceRoute =
  /** A repository's credential: by path, by numeric id, or both; `push` (receive-pack) and `write` (an API write) need a `write` grant. */
  | {
      kind: 'repository'
      plane: 'git' | 'api'
      repo?: string
      repoId?: string
      push?: boolean
      write?: true
      /** Asks a read lease; absent ⇒ an API request reads and git takes the agent's tier. */
      readOnly?: boolean
    }
  /** An API read that names no repository, answered with the workspace's read token. */
  | { kind: 'workspace' }
  /** A request whose repository only the upstream's answer names: the proxy GETs `target` with `via`'s read lease and forwards the request under the repository `owner` finds there, else answers `hidden`. */
  | {
      kind: 'lookup'
      via: RepositoryRef
      /** What the lookup GETs, its own query alone: nothing of the client's query or `accept` reaches it. */
      target: string
      owner: (answer: unknown) => RepositoryRef | undefined
      hidden: { status: number; reason: string }
      /** Headers the lookup sends beside the credential and a JSON `accept`. */
      headers?: Record<string, string>
      /** The forwarded request writes, so it needs a `write` grant on the owner; absent ⇒ it reads under a read lease. */
      write?: true
    }
  /** A request that needs no credential: forwarded with none. */
  | { kind: 'anonymous' }
  | { kind: 'deny'; status: number; reason: string }

/** One code host's part of the proxy; the router dispatches to it by provider. */
export interface ProxyRouteDescriptor {
  readonly provider: string
  /** Every instance of this provider is a SaaS name. */
  readonly saas?: true
  /** The minted credential goes as Basic with the grant's user, whatever scheme the client presented the placeholder in. */
  readonly basicAuthorization?: true
  /** Request headers whose presence alone refuses a request, such as a method override the upstream would run instead of the method routed. */
  readonly refusedHeaders?: readonly string[]
  /** The hosts the proxy serves an agent's managed host on, from its repositories there; absent ⇒ the managed host itself. */
  proxyHosts?(host: ManagedCredentialHost, repositories: readonly ProxyRepository[]): ManagedCredentialHost[]
  /** The credential one request on one of this provider's instances needs, by method and target (query included or not). */
  route(instance: ProxyInstance, method: string, target: string, context: ProxyRouteContext): InstanceRoute
}

export const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

const SEGMENT = /^[\w.-]+$/

/** A target's path, without its query. */
export function requestPath(target: string): string {
  return target.split('?')[0] ?? ''
}

/** The target's path under the instance's prefix, on a segment boundary; undefined outside it. */
export function underInstance(instance: ProxyInstance, target: string): string | undefined {
  return stripHostPathPrefix(requestPath(target), instance.pathPrefix)
}

function plainSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..' && segment !== '-'
}

/** A repository path from its segments, `.git` dropped from the last, lower-cased as the credential helper reads it; undefined for anything ambiguous. */
export function repositoryPath(segments: string[], nested: boolean): string | undefined {
  if (segments.length < 2 || (!nested && segments.length !== 2)) return undefined
  const named = [...segments.slice(0, -1), segments.at(-1)!.replace(/\.git$/i, '')]
  return named.every(plainSegment) ? named.join('/').toLowerCase() : undefined
}

/** The repository segments before a smart-HTTP service, or undefined when the path is not one. */
export function gitServicePrefix(segments: string[]): string[] | undefined {
  const last = segments.at(-1)
  if (last === 'git-upload-pack' || last === 'git-receive-pack') return segments.slice(0, -1)
  if (last === 'refs' && segments.at(-2) === 'info') return segments.slice(0, -2)
  return undefined
}
