import type { RdHookNotice } from '@agentconnect.md/protocol'

/**
 * The fixed text a `notice` delivery posts (webhook-triggers-and-github-events.md, "Trusted
 * users"). Daemon-authored: nothing the refused actor wrote is on the wire, let alone here.
 * It states the agent's policy and the one way forward, and names no one — not the actor,
 * not what they lacked, not who is trusted.
 */
export const HOOK_NOTICE_TEXT: Readonly<Record<RdHookNotice, string>> = {
  actor_not_trusted:
    "This agent responds to requests from this repository's maintainers and trusted contributors. A maintainer can mention it on this thread to have it take a look."
}
