/**
 * The Gitea entry of the code-host provider registry (`codehost/provider.ts`).
 *
 * G1 makes Gitea a KNOWN provider — the protocol constants, the pre-spawn host field and the
 * Setup Server instance address — and nothing more (gitea-integration.md §16). The Control Plane
 * exposes no route that can create Gitea state until G2, so every member here is the fail-closed
 * placeholder the registry's totality demands: the workspace arms answer "not mine" so core falls
 * through exactly as it does today, the hook axes answer their inert defaults, and the one
 * mutation refuses. Nothing throws at import time.
 *
 * The feature predicates are already the real ones. `gitea-v1` is a single string covering
 * gitea.com and a self-hosted address alike (§11), because a self-hosted instance is the same
 * code path — so nothing Gitea-shaped can reach a peer that has not advertised the slice.
 */
import { GITEA_V1_FEATURE } from '@agentconnect.md/protocol'
import type { CodeHostProviderModule } from '../codehost/provider.js'

export const giteaCodeHostProvider: CodeHostProviderModule = {
  provider: 'gitea',
  displayName: 'Gitea',
  repositorySubject: 'repository',
  features: {
    // G2 publishes the resolved instance (`resolveGiteaInstanceConfig`) on the HTTP deps; until a
    // connection can exist, no deployment addresses an instance and the value gates nothing —
    // `required` below does not read the host at all.
    deploymentHost: () => undefined,
    specHost: (spec) => spec.giteaHost,
    ruleHost: (rule) => (rule.provider === 'gitea' ? rule.rule.host : undefined),
    // §11: one string for both gitea.com and a self-hosted address, so a Gitea-shaped value is
    // frame-fatal on any peer without the slice and there is no separate instance bit to add.
    required: () => [GITEA_V1_FEATURE],
    // A spec that CARRIES the axis has a Gitea consumer somewhere — an enabled hook reaching a
    // running session is invisible in the workspace — so the bit is required for it too.
    requiredForInstance: (host) => (host !== undefined ? [GITEA_V1_FEATURE] : [])
  },
  workspace: {
    // G2 adds the Gitea repository catalog and the persisted credential. Until then no address is
    // a managed Gitea one and no stored credential names this host, so every arm declines.
    derive: async () => null,
    writeFromDerived: () => null,
    toDto: () => null,
    toSpec: () => null,
    legacySpecArm: () => null
  },
  hooks: {
    // Gitea's run state is a commit status, which is informational by construction: an operator
    // who makes the context a required check has chosen that themselves (§10.4).
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    // The per-repository managed webhook arrives with the provisioning saga in G2.
    convergeManagedRepository: () => {}
  },

  /** Unreachable until G2: the grant route's body admits no `gitea` arm, so no row names this host. */
  async upgradeRepoAuthorization({ reply }) {
    void reply
      .code(409)
      .send({ error: 'Conflict', statusCode: 409, message: 'Gitea repositories cannot be authorized yet' })
    return undefined
  }
}
