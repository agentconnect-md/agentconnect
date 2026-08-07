# Deployment provider integrations

Configure deployment-wide provider Apps in Setup at `http://localhost:8091`. These are different from most per-agent integrations configured later in the AgentConnect console. Saved settings take effect after restarting the consuming services.

## Dependency order

1. Set final public URLs.
2. Bootstrap Logto first when the provider will be a sign-in method.
3. Create or adopt the provider App in Setup.
4. Apply expected Logto settings when sign-in is enabled.
5. Restart `control-plane`, `relay`, and `web` as directed.
6. Run **Check match** and manually verify fields the provider API cannot expose.

Never request secrets through chat. Ask the user to enter them directly into Setup.

## Google sign-in

- Purpose: Logto social sign-in only; it is the recommended local bootstrap.
- Create a Web OAuth client using the exact authorized JavaScript origins and redirect URIs shown on Setup's Google card.
- On bundled localhost, preserve bare `localhost`; do not silently replace it with `127.0.0.1`.
- Save Client ID and Client Secret, apply expected Logto settings, restart API and Web, and run the available check. Manually compare displayed origins and redirects.

## GitHub App

- Purpose: private repositories, repository-scoped Git credentials, issue/PR triggers, and optionally Logto sign-in.
- Set final Web/API/Relay origins first.
- Prefer Setup → **GitHub → Create GitHub App**; the manifest flow fills callbacks, events, and permissions.
- For an existing App, save App ID, slug, Client ID/secret, base64 private key, and webhook secret as requested in Setup, then run **Check match**.
- On default local HTTP, Setup can create the App for sign-in and repository installation, but it leaves webhook delivery disabled. Reachable HTTPS Relay ingress is required for GitHub webhooks.
- Restart API and Relay. Then use AgentConnect → **Settings → GitHub** to install the App and select repositories.
- The Setup check cannot automatically verify every callback/setup/webhook-active field; record manual verification rather than claiming a full match.

## Slack deployment App

- Purpose: the built-in `agentconnect` bot and optional Slack sign-in. It does not replace recommended per-agent Slack bot integrations.
- Require HTTPS Logto, Web, API, and Relay origins. Setup deliberately disables Slack bootstrap on default localhost HTTP.
- When prompted, create a temporary Slack App configuration token in Slack and enter it directly in Setup.
- Choose **Create Slack App**; Setup generates OAuth, Events API, interactivity, and optional Logto redirect settings.
- Restart API and Relay, then run **Check match** with a fresh temporary configuration token if requested.
- For local evaluation, use Google sign-in and configure agent-specific Slack Socket Mode later in the AgentConnect console if that is the actual goal.

## Additional configuration

- Setup → **Options → Enable preset Agents** controls future built-in `agentconnect` provisioning and backfills; disabling it does not delete existing agents.
- Lark/Feishu cards configure trusted regional tenant Login Apps, not chat bots and not automatically Logto sign-in connectors.
- Agent-specific bots, agents, environments, tools, skills, schedules, and repository grants belong in the AgentConnect console, not Setup.

Use the current [deployment guide](https://docs.agentconnect.md/docs/deployment-and-configuration.md), [Slack guide](https://docs.agentconnect.md/docs/slack.md), and [GitHub guide](https://docs.agentconnect.md/docs/github.md) when provider UI or permissions have changed.
