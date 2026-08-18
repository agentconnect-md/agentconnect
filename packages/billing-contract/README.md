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

**First publish is manual.** npm will not let a trusted publisher be configured
for a package that does not exist, so the name has to be claimed by hand once
(`pnpm publish` from this directory), after which `release.yaml` is registered as
the trusted publisher on npmjs and the lane takes over. Until that happens the
lane skips itself with a log line rather than failing — it runs after the daemon,
cli and setup lanes, and a hard failure there would leave a tag pushed and those
three published from a run that then died. The guard clears itself the moment the
name exists; a registry error that is not a 404 still fails the release.

Version numbers therefore track the monorepo's release, and land sparsely — a
release that does not touch the contract does not republish it.

The console consumes the package as `workspace:*` regardless; only the
out-of-repo service installs it from npm.
