# Telegram and Discord permission sync

Refs #2985. Organization owners can enable each provider under **Settings → Session access**.
Members link their account in **Profile → Sign-in methods**. Session lists, detail,
transcripts, search and usage use the existing shared session-access resolver.

## Login applications

Configure one login application per platform for the installation, shared across
its organizations. Each agent keeps its own installed chat bot. The login
application proves the person's identity; the conversation's bot checks access.
No shared chat bot or per-organization login application is required.

### Telegram

Create a login bot in BotFather and register Logto's connector callback URL in its
Login Widget settings. Use the provided **OIDC client ID and secret**. Configure a
Logto OIDC social connector with target `telegram`, code flow and scope
`openid profile`. Use discovery at
`https://oauth.telegram.org/.well-known/openid-configuration` or its authorization,
token and JWKS endpoints. Set token authentication to HTTP Basic and validate
issuer `https://oauth.telegram.org`, client audience, expiry and signature.
Telegram returns profile claims in the ID token; no UserInfo request is needed.
Keep the default RS256 signing algorithm, which supports `profile`.

AgentConnect reads the Bot API user ID from Logto's verified `details.rawData.id`.
The OIDC `sub` is a different identifier and must never substitute for that ID.
Phone and messaging scopes are unnecessary. See
[Telegram Login](https://core.telegram.org/bots/telegram-login) and
[Logto OIDC](https://docs.logto.io/integrations/oidc).

### Discord

Create an OAuth2 application in the Discord Developer Portal. Register the
callback URL shown by Logto's Discord connector, then configure its client ID and
secret with target `discord`. The `identify` scope supplies the stable Discord
user ID; session permission checks use the installed bot's token. See
[Logto's Discord setup](https://docs.logto.io/integrations/discord).

Enable `telegram` / `discord` in the existing deployment browser social-provider
configuration and reconcile it through Setup Server. These connectors must
already exist in Logto; Setup Server validates and preserves them. Restart the
Control Plane to load the updated deployment snapshot. The switches are available
only when console identity lookup and the corresponding social provider are configured.
Complete a Profile link before enabling sync for the organization.

## Access rules

- Telegram DMs admit their participant. Groups require the conversation's bot to
  be an administrator before checking the viewer with `getChatMember`. Current
  members, administrators, owners and restricted users with `is_member` can read;
  departed or banned users cannot. Topic sessions use the containing group's audience.
- Discord DMs admit their recipients. Server conversations evaluate guild roles
  and everyone, combined-role, then member channel overwrites. Reading requires
  both View Channel and Read Message History. Threads inherit parent permissions;
  private threads also require membership or Manage Threads. Guild owners and
  administrators retain their normal bypass.
- Missing identities, revoked bots, mismatched organizations or realms, malformed
  responses and provider failures never grant access. Bot permission failures
  direct users to Integrations; missing identities direct them to Profile.
- Enabling sync also limits in-chat approvals and settings to linked Agent editors,
  following the same chat-authority policy as Slack.
- A successful provider verdict lasts at most two minutes, plus the shared
  session-access snapshot lease. Credential and scope revisions key verdicts;
  unlink invalidation and the shared policy fence continue to apply.

Membership semantics follow the [Telegram Bot API](https://core.telegram.org/bots/api#getchatmember)
and [Discord permissions](https://docs.discord.com/developers/topics/permissions).
Only identity and access metadata reach the Control Plane; message bodies stay on
the daemon data plane.

## Upgrade and toggle behavior

The migration marks historical Telegram/Discord conversations and inherited
children as pending candidates. Enabling sync fences them along with new sessions;
unresolved history stays hidden until a trusted milestone supplies its scope.
Upgrade the Control Plane before the daemons so it recognizes the new source providers.
The daemon upgrades known conversation bindings in place so the same runtime can
continue. Synthetic coordinates, console launches and ambiguous sources are not
claimed by a later chat message. Discord's conversation audience uses a stable bot
ID; its existing per-person memory identity stays unchanged.

Disabling sync makes new sessions organization-visible. Already protected
sessions stay hidden until sync is enabled again. Earlier agent memory is not
erased. These are the same policy transitions used by Slack.
