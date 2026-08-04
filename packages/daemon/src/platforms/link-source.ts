/**
 * The **session-link source strategy** (§7.4, stage S2).
 *
 * A provider-rendered session deep link carries a presentation-only `?source=`
 * hint: the console's generic 404 profile-linking action uses it to show the
 * right brand. Which hint a platform contributes is its own fact:
 *
 *  - Slack and GitHub brand as themselves;
 *  - Feishu and Lark share ONE protocol platform id, so the visible brand comes
 *    from the integration's region — a read of the integration's own (legacy
 *    disk-shape) config block, which is exactly why it belongs here and not in
 *    core;
 *  - everyone else contributes nothing, and the link renders unbranded.
 *
 * Presentation-only by contract: nothing routes on this value, so the open
 * `string` return is safe and the console treats unknown hints as no hint.
 */

type LinkSource = (integration: unknown) => string | undefined

const SOURCES = new Map<string, LinkSource>([
  ['slack', () => 'slack'],
  ['github', () => 'github'],
  [
    'feishu',
    (integration) => {
      // The integration's own config block (legacy disk shape until the emission
      // flip); structurally read so this file needs no agent-schema import.
      const feishu = (integration as { feishu?: { region?: string } } | undefined)?.feishu
      return feishu?.region
    }
  ]
])

/** The `?source=` hint for a session link delivered via `platform` /
 *  `integration`. Total by construction: no registered source means no hint. */
export function sessionLinkSourceFor(platform: string, integration?: unknown): string | undefined {
  return SOURCES.get(platform)?.(integration)
}
