# Bundled local Logto tutorial

Use only with `compose.yaml` plus `compose.logto.yaml`. Follow the current [Logto authentication guide](https://docs.agentconnect.md/docs/logto-authentication.md) if labels or provider requirements differ.

## 1. Start and initialize Logto

```bash
docker compose -f compose.yaml -f compose.logto.yaml up -d
```

Open the configured Logto admin location (default `http://localhost:3002`) and complete Logto Console onboarding for a new database. Keep Setup open locally at `http://localhost:8091`.

Checkpoint: both consoles load and Compose shows the expected services.

## 2. Create Logto Management credentials

In Logto Console → **Applications**:

1. Create a **Machine-to-machine** application.
2. Assign the built-in **Logto Management API access** role.
3. Copy its App ID and App Secret for direct entry into Setup.

In Setup, choose **Continue setup** and enter the M2M values under **Connect Logto**. Use this Management API resource for bundled Logto OSS:

```text
https://default.logto.app/api
```

Choose **Save Logto and continue**. Do not collect the credentials in chat.

Checkpoint: Setup says Management API access is ready and advances to provider selection.

## 3. Configure the first provider

Recommend Google for the shortest bootstrap:

1. Select **Google (works on localhost)**.
2. In Google Auth Platform, create a Web application OAuth client.
3. Copy exactly the authorized JavaScript origin and redirect URIs displayed by Setup. With defaults, the bundled flow intentionally uses bare `localhost`; with a tunnel, it must display the final stable HTTPS origins. Do not substitute a different host.
4. Enter the Client ID and Client Secret directly in Setup.
5. Choose **Save Google OAuth and configure Logto**.

GitHub is also supported as the first provider and creates one App for sign-in plus repository integration. On localhost, webhook delivery remains disabled until HTTPS Relay ingress exists.

Do not choose Slack while any required origin is HTTP. A stable HTTPS tunnel may make Slack available only after Logto, Web, API, and Relay public origins are all configured and reachable.

## 4. Claim the first administrator

1. Choose **Sign in with Logto** in Setup.
2. Complete social sign-in.
3. Allow Setup to assign the first user the `ADMIN` role.
4. Sign in once more so the refreshed token contains the role.

Checkpoint: the full **AgentConnect deployment settings** page opens.

## 5. Apply and verify

In Setup → **Logto**, choose **Check match**. If expected resources differ, inspect the diff and choose **Apply expected settings** only after confirming the saved desired state.

Restart consumers with the same overlay:

```bash
docker compose -f compose.yaml -f compose.logto.yaml restart control-plane relay web
```

Open AgentConnect in a private window and verify sign-in. The bundled overlay may use the SPA ID token without a custom API Resource, which is acceptable for local evaluation but is not the normal renewable production session.
