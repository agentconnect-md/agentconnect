# Email ingress Worker

The Cloudflare Email Worker that hands each message sent to an agent's address
to the AgentConnect relay
([email integration design](../../docs/designs/email-integration.md) §7). It
reads at most the first 1 MiB of the raw message, posts it to the relay's
`POST /email/inbound` with the envelope sender and recipient, the message's
full size and an HMAC signature, and applies the relay's answer:

| Relay answer                  | Worker                                                    |
| ----------------------------- | --------------------------------------------------------- |
| `200 {"result":"accepted"}`   | returns; the message is accepted                          |
| `200 {"result":"reject",...}` | `setReject(reason)`; the sender gets a permanent error    |
| anything else, or no answer   | throws after 10 seconds at most; the sender retries later |

It parses nothing, has no runtime dependency and holds no other configuration.

## Deploy

1. Copy `wrangler.toml.example` to `wrangler.toml` and set `RELAY_URL` to the
   relay's public origin, for example `https://relay.example.test`.
2. Deploy it from this directory with `npx wrangler deploy`.
3. Set the ingress secret that **Setup → Email** generated:
   `npx wrangler secret put INGRESS_SECRET`.
4. In the mail domain's zone, open **Email → Email Routing → Routing rules** and
   set the **catch-all** rule's action to **Send to a Worker**, naming this
   Worker.

The mail domain must be a zone of its own whose every address reaches the
Worker; one deployment needs one domain.

## Contract with the relay

The header names, the signing input, the 1 MiB limit and the 10-second wait
mirror `@agentconnect.md/protocol` (`EMAIL_INGRESS_HEADERS`,
`emailIngressSigningPrefix`), and a test fails if they drift. The signature is
`v1=<hex HMAC-SHA256>`, keyed by the ingress secret, over
`v1\n<timestamp>\n<size>\n<from>\n<to>\n` followed by the posted bytes, where
each value is exactly the header as sent: the timestamp in epoch milliseconds,
and the two envelope addresses percent-encoded. The relay refuses a timestamp
more than five minutes from its own clock.
