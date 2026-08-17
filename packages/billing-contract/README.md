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

## Status

Not on npm yet. The console consumes it as a `workspace:*` dependency; the
private service still carries its own copy of the schemas. Publishing it (and
switching that service to the published version) is one dependency line plus a
release lane — see `release.config.js`, which today publishes only `daemon`,
`cli`, and `setup`.
