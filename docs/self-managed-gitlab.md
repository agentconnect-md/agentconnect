# Connect AgentConnect to a self-managed GitLab

AgentConnect talks to **one** GitLab instance per deployment: either GitLab.com
or one self-managed instance, never both. Everything else about the integration
— identities, credentials, webhooks, reviews — is the same on either.

This guide uses the RFC 2606 documentation name `https://gitlab.example.test`.
Replace it with your own instance URL.

## What the instance must provide

| Requirement               | Why                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitLab **18.11 or later** | Group service accounts reached every tier, Community Edition included, at 18.11. Below that the Free-tier answer sits behind instance feature flags the API does not report, so AgentConnect refuses to provision rather than guess. |
| **HTTPS**, one address    | Clone URLs, OAuth redirects, and GitLab's own `web_url` values only agree if there is a single address. Split internal and external addressing belongs in DNS.                                                                       |
| A trusted certificate     | There is no skip-verify option at any layer. A private authority is supported by installing its bundle — see below.                                                                                                                  |
| Projects in a **group**   | Each agent acts as a group service account, so a project in a personal namespace cannot be set up — AgentConnect reports `personal_namespace_unsupported`. Move the project into a group first.                                      |

An instance that drops below the floor after projects are already set up keeps
serving them: existing sessions and credentials work until they expire, and
only new setup is refused. The Control Plane records the version it observes,
and the console shows it on the GitLab connection.

## Register the OAuth application

AgentConnect uses one OAuth application per deployment as its **administration**
identity. Register it on your instance, then enter the Application ID and Secret
in Setup.

- Your own applications: `https://gitlab.example.test/-/user_settings/applications`
- An instance-wide one, as an administrator: `https://gitlab.example.test/admin/applications`

Keep **Confidential** selected, request the `api` scope, and set the redirect URI
to exactly the value Setup publishes. GitLab shows the secret only once.

Setup's GitLab card takes the instance base URL beside that pair. A path prefix
(`https://gitlab.example.test/gitlab`) and a non-default port are both supported
and are preserved everywhere. When the URL is saved, Setup probes the instance:
only an invalid URL blocks the save — an unreachable host, an untrusted
certificate chain, or a response that is not a GitLab API root are reported as
warnings, because Setup and the Control Plane need not share a network position.

**The base URL cannot be changed while GitLab state exists.** Connections,
tokens, numeric project IDs, and cleanup obligations carry no instance
provenance, so retargeting would send one instance's credentials to another.
Disconnect every GitLab project and connection first.

## Who may create the agent bot accounts

Each agent acts on GitLab as its own group service account. Creating one needs
authority that **no GitLab API reports**, so AgentConnect cannot check it in
advance and cannot probe for it — a probe would leave half-created accounts
behind. The truth arrives the first time a project is set up, and a refusal is
reported on the agent's bot in the console with the remedy.

Any one of these is enough:

- **Any tier, including Community Edition:** connect a GitLab account that is an
  **instance administrator**. No special handling — it is the same code path.

  One caveat: when **Admin Mode** is enabled, administrator API actions require
  the `admin_mode` token scope, which AgentConnect's OAuth application does not
  and will not request. On an Admin-Mode instance the delegation setting below
  is the only path.

- **Premium or Ultimate:** turn on **Allow top-level group Owners to create
  service accounts** under **Admin → Settings → General → Account and limit**.
  The installing user then provisions exactly as on GitLab.com. The setting
  itself is Premium/Ultimate-only.

**Free and Community Edition allow 100 service accounts per instance** (on
GitLab.com Free the same limit is per top-level group). The population is
agents-with-projects, so plan against the tighter ceiling; a refused creation is
reported as a quota failure and leaves existing credentials untouched.

If an instance also caps **maximum allowable access token lifetime**, an expiry
shorter than AgentConnect requests is accepted as your policy and credential
rotation simply runs on that shorter cycle. An instance that rejects the request
outright instead of shortening it is reported with a message naming the cap.

## Certificate authority bundle

If your instance presents a certificate from a private authority, the bundle
must be readable **at a file path that exists inside each process**, including
the agent sandbox. Point every runtime at it:

| Variable              | Reached by                                         |
| --------------------- | -------------------------------------------------- |
| `NODE_EXTRA_CA_CERTS` | The orchestration service and the daemon (Node.js) |
| `SSL_CERT_FILE`       | Tools that read the OpenSSL default bundle         |
| `SSL_CERT_DIR`        | The hashed-directory form of the same              |
| `GIT_SSL_CAINFO`      | Git itself, for clone, fetch, and push             |

A path that exists only on the host is not enough: an agent runs in a sandbox
with its own filesystem view, so the bundle has to be mounted there too, and the
variables have to survive into the sandbox environment. Set them where the
sandbox image and its environment are configured, not only on the host.

## Network access

Three components need to reach the instance, and one does not:

- **The orchestration service** calls the GitLab API outbound over HTTPS for
  every administrative action: version checks, project reads, service accounts,
  tokens, and webhook management.
- **The daemon** calls the API for turn-time reads and effects, and clones,
  fetches, and pushes over HTTPS.
- **The agent sandbox** clones and pushes over HTTPS, and runs `glab` against
  the instance.
- **The public ingress endpoint that terminates GitLab webhooks never dials
  GitLab.** It only receives. It needs no certificate bundle and no outbound
  access to the instance.

Traffic runs to the one base URL you configured. SSH remotes and mutual TLS are
outside the contract, and there is no HTTP option. An outbound HTTP proxy is not
supported yet.

## Allow the daemon to clone your instance

Nothing to do for the instance you configured: a daemon authorizes a clone against
the code host the agent's own specification names — the same address it already
uses to decide where that agent's git credential may go — so a workspace on your
instance, or an additional repository on it, clones with no local configuration
anywhere.

The operator policy behind that is `security.workspaceGitAllowedOrigins` in a
daemon's config file (`daemonPool.workspaceGitAllowedOrigins` in the Helm chart,
where members have no config file). Reach for it only to allow something _else_ —
a second host, an SSH remote — or to restrict: an explicit empty list turns remote
Git workspaces off entirely, and nothing is adopted past that.

## Let GitLab reach the webhook endpoint

GitLab blocks webhook requests to the local network by default. If your
AgentConnect ingress endpoint resolves to a private address, GitLab silently
refuses to deliver — the integration looks installed and stays quiet.

Add that one host to **Admin → Settings → Network → Outbound requests →
Local network endpoints allowed for webhooks**. Prefer this per-host allowlist
over the instance-wide "Allow requests to the local network from webhooks and
integrations" toggle: it grants exactly what is needed. A webhook GitLab refuses
for this reason is reported with its own message rather than a generic failure.

## Checklist

1. Instance is 18.11 or later, on HTTPS, at one address.
2. OAuth application registered, `api` scope, Confidential, exact redirect URI.
3. Instance base URL saved in Setup; probe warnings understood.
4. Bot-creation authority granted — delegation setting or administrator
   connection — with the Admin Mode caveat considered.
5. Private authority bundle mounted and exported to the orchestration service,
   the daemon, and the sandbox.
6. Webhook endpoint host on the outbound allowlist if it is on a private
   network.
7. Connect a GitLab account in the console, add a project, and confirm the bot
   appears and a webhook is installed.
