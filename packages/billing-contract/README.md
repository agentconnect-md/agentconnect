# @agentconnect.md/billing-contract

The billing wire contract: zod schemas and their inferred types, zero
implementation. Shared by the console (client types) and the closed-source
billing service (request validation, response types), which live in **different
repositories** — this package is how one declaration serves both.

Publishing it leaks nothing: the wire format is already visible in any browser's
network panel. The implementation — pricing, entitlement evaluation, metering —
is not here and never will be. The one real leak surface is a field arriving
ahead of the feature that uses it, so **a field enters this package when its
feature ships**.

Amounts are integer microUSD (1 USD = 1_000_000). Formatting is the console's
business; arithmetic on money is the service's.

## Publishing

`release.config.js` gives this package its own release lane, alongside `daemon`,
`cli`, and `setup`: `scripts/publish-billing-contract-if-changed.sh` runs on every
semantic-release, skips when nothing in `packages/billing-contract` (or the root
files that decide how it builds) changed since the last tag, and otherwise stamps
the release version, builds `dist/`, and publishes with npm OIDC trusted
publishing — no token to manage.

It differs from the other three lanes in one way that matters: they are
self-contained bundles whose manifests are stripped to zero runtime deps, while
this is a real library, so its `zod` dependency stays declared.

Version numbers therefore track the monorepo's release, and land sparsely — a
release that does not touch the contract does not republish it.

The console consumes the package as `workspace:*` regardless; only the
out-of-repo service installs it from npm.
