# Live e2e: real ACP agents driven through the daemon's real Slack send path

One live test (`slack-live.test.ts`) that launches **every ACP agent actually installed
on this host** and drives each one **through a full `Daemon` over the daemon's real Slack
send path** — so the daemon itself renders and posts the agent's output into the thread.

1. A driver user (xoxp) posts `"acp integration tests - <ISO timestamp>"`, opening the
   thread.
2. Installed runtimes are discovered (`installedRuntimes` over the ACP registry). For
   each, a full `Daemon` is booted with a **shared-mode Slack integration** (a send-only
   Web-API client — no Socket Mode) and the agent is driven (`drive-daemon.ts`):
   - a **bot_id-free `@mention` is injected** into the daemon and `dispatch`ed to the
     integration, so the **daemon renders and POSTS** the reply + status bar into the
     thread (the messages you see from the bot are the daemon's, not the test's);
   - **model / permission-mode switching** goes through `Daemon.handleStatusAction` (the
     status-modal code) — the new model shows up in the status bar the daemon posts — and
     is read back via `Daemon.statusInfoForKey`;
   - a **tool-triggering turn** makes the daemon post a real **Allow/Deny card**, which the
     test resolves via `Daemon.handlePermissionChoice` (the daemon then edits the card to
     "Permission resolved");
   - **native session resume** is exercised by evicting the live host and dispatching
     again.
     All 9 matrix feature dimensions, with the agent's REAL data.
3. Beneath the daemon's own messages, the test posts a structured per-agent verdict
   summary, then a summary table.

The thread therefore shows the daemon's real output — status bars, agent replies, tool
calls, permission cards — interleaved with the test's verdict lines. Nothing is
hand-posted on the agent's behalf.

### Feature coverage

`caps · life · model · pmode · load · perm · usage · mem` are driven end-to-end through
the daemon's Slack path. **elicitation** stays ⚪ n/a — real agents don't emit
`elicitation/create` on cue; that card path is covered by the scriptable-fixture matrix in
[`../acp-matrix.test.ts`](../acp-matrix.test.ts). `perm` shows ✓ when an agent actually
requested a gated tool (card rendered + resolved) and `·` when it completed without one.

### Pass/fail

Reachable agents must reply, and any switch actually exercised must read back applied (a
`fail` cell fails the test). Agents that can't authenticate on this host are reported
`UNAVAILABLE`; capability-gated features an agent doesn't advertise are `degrade`. Real
turns hit real providers, so an agent must be installed **and** authenticated to be
reachable, and the run takes several minutes.

## Gating

Skipped unless all required env vars are set (green in CI and a plain `pnpm test`).

| Env var                    | Value    | Purpose                                                        |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `AC_LIVE_SLACK_BOT_TOKEN`  | `xoxb-…` | The bot the daemon posts agent replies / status / cards as.    |
| `AC_LIVE_SLACK_USER_TOKEN` | `xoxp-…` | The driver user: opens the thread + is the injected sender id. |
| `AC_LIVE_SLACK_CHANNEL`    | `C…`     | A channel the bot is a member of.                              |

## Run

```bash
export AC_LIVE_SLACK_BOT_TOKEN=xoxb-… AC_LIVE_SLACK_USER_TOKEN=xoxp-… AC_LIVE_SLACK_CHANNEL=C…
GITHUB_ACTIONS=true pnpm --filter @agentconnect.md/daemon exec \
  vitest run test/acp-matrix/live/slack-live.test.ts
```

(`GITHUB_ACTIONS=true` works around the repo's reporter helper returning `undefined`
outside CI, which vitest 4 rejects.)
