/**
 * The **session-link source strategy** (§7.4, stage S2).
 *
 * A provider-rendered session deep link carries a presentation-only `?source=`
 * hint: the console's generic 404 profile-linking action uses it to show the
 * right brand. Which hint a platform contributes is its own fact:
 *
 *  - Slack and GitHub brand as themselves;
 *  - Feishu and Lark share ONE protocol platform id, so the visible brand comes
 *    from the integration's region — read through the platform module's
 *    VALIDATED config (§6.4), which also applies the schema default (`'feishu'`
 *    when a hand-authored payload omits the field, exactly as the pre-flatten
 *    parse did);
 *  - everyone else contributes nothing, and the link renders unbranded.
 *
 * Presentation-only by contract: nothing routes on this value, so the open
 * `string` return is safe and the console treats unknown hints as no hint.
 */
import type { Integration } from '../agents/agent-schema.js'
import { platformIntegrationConfig } from './integration-config.js'

type LinkSource = (integration: Integration | undefined) => string | undefined

const SOURCES = new Map<string, LinkSource>([
  ['slack', () => 'slack'],
  ['github', () => 'github'],
  ['feishu', (integration) => (integration ? platformIntegrationConfig('feishu', integration)?.region : undefined)]
])

/** The `?source=` hint for a session link delivered via `platform` /
 *  `integration`. Total by construction: no registered source means no hint. */
export function sessionLinkSourceFor(platform: string, integration?: Integration): string | undefined {
  return SOURCES.get(platform)?.(integration)
}
