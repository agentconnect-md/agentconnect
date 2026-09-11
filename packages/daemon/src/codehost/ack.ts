/**
 * The daemon's turn-start ACKNOWLEDGEMENT member for code hosts (gitlab-com-integration.md
 * §6.5; webhook-triggers-and-github-events.md · Outbound).
 *
 * A code-host turn publishes ONE comment at the very end, so between the mention and the
 * answer a human sees nothing at all — the gap a chat platform fills with a typing hint or
 * a status bar, and which a review turn can hold open for minutes. Both providers close it
 * the same way: react to the exact comment that fired the turn, or to the subject when the
 * subject itself fired it.
 *
 * That shared shape is why this is a seam member and not a branch. The two arms differ only
 * in path, auth header and body — each provider owns its own three, the reply target's provider
 * selects between them, and adding a code host is adding one entry.
 *
 * Best-effort by construction: nothing here throws, the turn never awaits it, and a failure
 * is one warn. A lost reaction costs a signal, never the answer. The reaction is also never
 * withdrawn — it records that the turn was seen, which stays true even when the turn later
 * dies without publishing.
 */
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { replyTargetProvider, type CodeHostReplyTarget } from './reply-target.js'
import { giteaNotImplemented } from '../gitea/not-implemented.js'

/** Bounded because it races a prompt that is already starting; an unreachable host must
 *  never hold a turn open, and a late reaction is worthless anyway. */
const ACK_TIMEOUT_MS = 5_000

export interface CodeHostAckDeps {
  /** The same repo-targeted mint the turn's poster uses; reactions need no wider grant. */
  token: () => Promise<string>
  /** The provider's REST root for this turn (GitLab resolves its instance per turn, §24.4). */
  apiBaseUrl: () => string
  log: { warn: (message: string) => void }
  fetchImpl?: typeof fetch
}

/** One provider's acknowledgement request. */
interface CodeHostAckAdapter {
  readonly provider: CodeHostProvider
  request(target: CodeHostReplyTarget, token: string, apiBaseUrl: string): { url: string; init: RequestInit }
}

const githubAck: CodeHostAckAdapter = {
  provider: 'github',
  request(target, token, apiBaseUrl) {
    // A PR review comment and a conversation comment are different GitHub resources with
    // different reaction paths; a delivery with neither was fired by the subject, and a PR
    // reacts through `/issues/:number` like any other issue.
    const path =
      target.triggerComment?.kind === 'review_comment'
        ? `/repos/${target.repo}/pulls/comments/${target.triggerComment.id}/reactions`
        : target.triggerComment?.kind === 'issue_comment'
          ? `/repos/${target.repo}/issues/comments/${target.triggerComment.id}/reactions`
          : `/repos/${target.repo}/issues/${target.number}/reactions`
    return {
      url: `${apiBaseUrl}${path}`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28'
        },
        body: JSON.stringify({ content: 'eyes' })
      }
    }
  }
}

const gitlabAck: CodeHostAckAdapter = {
  provider: 'gitlab',
  request(target, token, apiBaseUrl) {
    // `repo` is the numeric project id on a GitLab target and `number` the subject IID (§14.1).
    const subject = `/projects/${target.repo}/${target.subjectKind === 'merge_request' ? 'merge_requests' : 'issues'}/${target.number}`
    const path =
      target.triggerComment?.kind === 'note'
        ? `${subject}/notes/${target.triggerComment.id}/award_emoji`
        : `${subject}/award_emoji`
    return {
      url: `${apiBaseUrl}${path}`,
      init: {
        method: 'POST',
        headers: { 'private-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'eyes' })
      }
    }
  }
}

/**
 * Gitea's acknowledgement is G4's (gitea-integration.md §10.1): the reaction is only placed after
 * reading the instance's allowed-reaction list once per connection, so there is a request to build
 * and a 403 to read as "no reaction" rather than as a credential fault. Until then the adapter
 * refuses — caught below like any other failure, so the turn loses a signal and nothing else. It is
 * unreachable anyway: a reply target is what selects an adapter, and Gitea produces none yet.
 */
const giteaAck: CodeHostAckAdapter = {
  provider: 'gitea',
  request: () => giteaNotImplemented('turn-start reactions')
}

/** Adding a code host is adding one entry; the record over the provider union makes a missing one a compile error. */
const ACKS: { readonly [P in CodeHostProvider]: CodeHostAckAdapter } = {
  github: githubAck,
  gitlab: gitlabAck,
  gitea: giteaAck
}

/**
 * Place the "seen it" reaction on whatever fired this turn. Resolves once the request
 * settles or the bounded wait expires; never rejects.
 *
 * A repeat is deliberately not suppressed — both hosts treat a reaction that is already
 * present as a success, so a redelivered turn needs no state of its own to stay idempotent.
 */
export async function acknowledgeCodeHostTrigger(target: CodeHostReplyTarget, deps: CodeHostAckDeps): Promise<void> {
  const adapter = ACKS[replyTargetProvider(target)]
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const { url, init } = adapter.request(target, await deps.token(), deps.apiBaseUrl())
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(ACK_TIMEOUT_MS) })
    // The body is never read; drain it so the socket is released rather than parked.
    try {
      await res.body?.cancel()
    } catch {
      // Best-effort resource cleanup only.
    }
    if (!res.ok) deps.log.warn(`${adapter.provider} ack: reaction rejected (HTTP ${res.status})`)
  } catch (err) {
    deps.log.warn(`${adapter.provider} ack: reaction failed (${err instanceof Error ? err.message : String(err)})`)
  }
}
