# Voice Meeting Participation

> **Status:** Draft — a research assessment with a phased plan; nothing here is
> implemented. It answers [issue #2361](https://github.com/agentconnect-md/agentconnect/issues/2361)
> ("be able to talk or group meet in voice with agent"). File/line references describe
> the shipped machinery as of 2026-09-28; platform facts in §3 were checked against
> vendor documentation on the same date and are the part of this document most likely
> to go stale.
>
> **Scope:** daemon and protocol, a meeting runner the daemon dials, and one console
> surface per phase. Google Meet is the first room by product priority (§6.2); every chat
> platform the daemon owns is assessed too, and Zoom, Microsoft Teams and Slack huddles
> follow Meet through the same runner seam. Speech models are external services in every
> phase — no Claude or Codex runtime accepts audio today (§3.7).
>
> Related documents:
> [architecture.md](architecture.md) (the Control Plane stays off the hot path — audio is
> message content),
> [integration-plugin-architecture.md](integration-plugin-architecture.md) (the seam every
> host change lands in),
> [message-intake.md](message-intake.md) (a spoken utterance is one channel-record row),
> [decisions.md](decisions.md) (the addressing gate and the provider-key seam),
> [channel-session-mode.md](channel-session-mode.md) (a room is an `append` conversation),
> [loop-breaker-design.md](loop-breaker-design.md) (an agent's own voice must not re-enter),
> [agent-authored-attachments.md](agent-authored-attachments.md) (the outbound byte path a
> spoken reply reuses),
> [inbound-file-attachments.md](inbound-file-attachments.md) (the inbound landing zone a
> voice note reuses),
> [webchat-multi-agents.md](webchat-multi-agents.md) (the console conversation a voice
> session extends),
> [../product-conventions.md](../product-conventions.md).

## 1. Background and goal

Issue #2361 asks for two things in one line: **talk in voice with an agent**, and **group
meet in voice with an agent**. The issue carries no body, so this document fixes what each
ask means before it fixes how to build it.

- _Talk in voice_ is one human and one agent, where the human speaks instead of typing and
  may prefer to hear the answer. It is asynchronous today (a voice note in Telegram) and
  synchronous tomorrow (a live microphone in the console).
- _Group meet in voice_ is several humans in a call — a Discord voice channel, a Google
  Meet, a Slack huddle — with an agent in the room as a participant: it hears what is said,
  answers when addressed, and carries the discussion into work it does afterwards.

The answer, up front:

- **A coding agent cannot be a voice assistant.** One ACP turn takes seconds to minutes and
  the runtime never accepts audio. The agent therefore joins a meeting the way it joins a
  Slack channel: as a participant that listens continuously, is addressed by name, answers
  in a bounded spoken form, and keeps working after the call. §2 makes that model precise;
  every later section is downstream of it.
- **Every platform needs the same core** (§5): a speech-provider seam, a voice room that
  turns audio into channel-record rows and spoken replies, and turn-taking rules on top of
  machinery the daemon already has — steering into a live turn, the addressing ladder,
  the Decision gate, and the turn output surface.
- **Google Meet is the first room** (§6.2): the agent joins a meeting as a participant and
  transcribes it. Google's own real-time media API is receive-only and preview-gated (§3.3),
  so the participant is a **meeting runner** — a browser-driving process beside the daemon,
  first-party or an adopted open-source one — that reads Meet's live captions or streams the
  call's audio to the speech seam, while the daemon owns the record and the routing (§5.5).
  Google's official post-meeting transcript API complements it where the organization has it.
- **Discord is the only platform the daemon already owns whose voice API is open** (§3.1),
  so it is the one native driver, after Meet (§6.4). Slack has no huddle API and forbids bots
  in huddles (§3.2); Telegram's Bot API cannot join a group call (§3.6); Zoom's streaming API
  is receive-only and its participant SDK is native C++ (§3.4); Teams' media bot is .NET on
  Windows (§3.5). Zoom and Teams follow Meet through the runner seam; huddles only with a
  runner the organization brings.
- **Voice notes are the smallest slice and the speech-provider seam** (§6.1): every platform
  already delivers audio files the daemon drops or hands over as an opaque link. Phase 1 does
  not wait on them — Meet supplies its own captions — and the two proceed in parallel.

## 2. What "join a meeting" has to mean for a coding agent

### 2.1 The latency argument

A voice assistant answers within a second because a single model call produces the whole
reply. AgentConnect drives Claude Code or Codex over ACP: `AcpHost.prompt`
(`packages/daemon/src/acp/acp-host.ts:1258`) is one blocking `session/prompt`, the runtime
reads files, runs tools and thinks, and a turn that touches a repository routinely runs a
minute or more. Speech-to-speech models that bypass the runtime would answer fast and would
not be the agent the user asked for; §6.7 rejects that shortcut.

So the agent in a meeting is not the party you take turns with. It is the colleague who
sits in, says "let me check" when asked, and comes back with an answer while the
discussion has moved on. Three consequences shape the whole design:

1. **Listening is recording, not reacting.** Every utterance in the room is a channel-record
   row ([message-intake.md](message-intake.md) §3), whether or not any agent responds. A
   later activation is given the recent window as context, so "what did we decide about the
   migration" works because the transcript is there, not because the agent was awake.
2. **Answering is admission.** An utterance that addresses the agent is admitted into its
   session and starts a turn — or, when a turn is already running, is **steered** into it
   over `_session/steering` (`steerIntoLiveTurn`, `packages/daemon/src/daemon.ts:11430`),
   exactly as a follow-up Slack message is today. Nothing new is needed to let a human say
   "actually, also check the tests" mid-turn.
3. **Speaking is a bounded rendering of the reply.** The spoken form is one more turn
   output surface ([integration-plugin-architecture.md](integration-plugin-architecture.md)
   §7.3): a few sentences, never reasoning or tool output, with the full written reply
   posted to the room's text companion.

### 2.2 Three room modes

| Mode        | Who is admitted                                    | Typical use                                                      |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `listen`    | Nobody; every utterance is an observation          | Note-taker; "catch up on the meeting" from Slack later           |
| `addressed` | Utterances that name the agent, or pass a Decision | Group meeting with an agent in the room (the issue's second ask) |
| `talk-back` | Every utterance from the owner                     | One human, one agent (the issue's first ask)                     |

`addressed` reuses the two admission mechanisms the shared-bot path already has: the
name-match ladder and the **By decision** gate ([decisions.md](decisions.md) §4). Speech
recognition mangles names ("Claude" arrives as "cloud"), so the name match takes a per-agent
alias list and the Decision is the fallback for a room whose owner wants "answer when we are
clearly asking you" rather than a keyword.

### 2.3 Turn-taking rules

- **Acknowledge on admission.** The turn-start `react(seen)` intent (§7.1 of the plugin
  design) has a spoken counterpart: core names the intent, the voice surface picks a short
  phrase ("On it."). Without it a room hears nothing for a minute and assumes the agent
  missed the question.
- **Speak final text only** by default; a `medium` room may also speak progress notices,
  which are already a distinct action in every converger (`notice`/`progress` in
  `packages/daemon/src/discord/render.ts:35-48`). Reasoning and tool output are never spoken.
- **Bound the spoken reply.** The session's voice-mode prompt hint asks for a spoken answer
  of at most three sentences followed by the written detail; the surface additionally caps
  speech at a configurable length (default 45 s of audio) and says where the rest was
  posted. Both are needed: the hint keeps replies shaped, the cap keeps a runaway reply
  from holding the floor.
- **Barge-in.** A human speaking while the agent speaks stops playback; the written reply
  is unaffected. The dropped remainder is not re-spoken.
- **Never hear yourself.** An agent's own speech, and any other bot's, must not re-enter
  as an utterance. Discord identifies each speaker, so bot users are dropped at the source,
  the same identity rule the echo-drop uses. A mixed stream from a meeting provider relies
  on the provider's speaker labels and on muting the transcriber while the agent speaks.
  This is the voice arm of [loop-breaker-design.md](loop-breaker-design.md).

## 3. Platform landscape

What each platform lets a bot do in a call, checked on 2026-09-28. "Bot" here means an
application identity, not a signed-in human account.

| Platform              | Bot joins the call                                    | Receives audio                                                                                                | Sends audio             | Verdict                                   |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| Discord voice channel | Yes, gateway voice                                    | Per speaker, decrypted with DAVE                                                                              | Yes                     | **Native driver** (§6.4)                  |
| Slack huddles         | No API; bots are blocked                              | Only through a signed-in human account in a browser                                                           | Same                    | Provider seam only, flagged (§3.2)        |
| Google Meet           | Media API: no participant; a browser participant does | Media API: receive-only, developer preview, every participant enrolled; a participant reads captions or audio | Participant only (§6.3) | **First room** (§6.2), through the runner |
| Zoom                  | Meeting SDK for Linux (C++)                           | RTMS (GA, receive-only) or SDK raw audio                                                                      | SDK only                | Provider seam                             |
| Microsoft Teams       | Graph calling bot                                     | App-hosted media, .NET on Windows only                                                                        | Same                    | Provider seam                             |
| Feishu / Lark         | No real-time media API found                          | Post-meeting recordings and Minutes                                                                           | No                      | Not a room; voice notes only (§3.6)       |
| Telegram              | Bot API cannot join calls                             | User account over MTProto only                                                                                | Same                    | Not a room; voice notes only              |
| Webchat (console)     | Our own surface                                       | Browser microphone                                                                                            | Browser playback        | Second room, one human (§6.4)             |

### 3.1 Discord

A bot connects to a voice channel over the gateway with the `GuildVoiceStates` intent and
the `CONNECT` and `SPEAK` permissions, sends Opus over UDP, and receives one stream per
speaker. discord.js ships this as `@discordjs/voice`. Two facts set the cost:

- **End-to-end encryption is mandatory.** Discord finished rolling out its DAVE protocol to
  voice channels and enforces it for every client since March 2026. `@discordjs/voice`
  gained DAVE in the change merged on 2025-07-13 (voice 0.19) through the `@snazzah/davey`
  library, including decryption on the receive side. Any older voice stack cannot join.
- **Receiving is not officially documented.** Discord documents sending; receiving works
  and is what every transcription bot uses, but there is no support commitment. This is a
  stability risk, not an availability one, and §8 carries it.

Voice channels also have a built-in text chat, which is the natural text companion (§5.3).

### 3.2 Slack huddles

Slack exposes no API for huddle audio or transcripts and does not admit third-party bots
to a huddle. The only working approach in the wild is a **signed-in human Slack account**
driving a browser: a dedicated user joins the huddle, page audio is captured, and a virtual
microphone plays synthesized speech back. OpenClaw's huddle plugin and the `claw-huddle`
project both do exactly that. It costs a licensed seat per agent, runs against Slack's
intended use, and every review of OpenClaw's change centred on proving the bot could not be
tricked into the wrong huddle. AgentConnect should not ship it as a first-party module; an
organization that wants it can point the provider seam (§5.5) at a runner of its own.

Slack's own transcript products are the better fit. An **audio clip** posted in a channel
is a file whose object carries Slack's transcription once Slack has produced one, so phase 0
gets Slack voice notes with no speech provider at all. A **huddle** with AI notes leaves a
notes canvas in the huddle thread with the transcript embedded in it; today the Slack
normalizer reduces that canvas to a file link (`packages/message/src/slack-message.ts:139-155`)
and nothing reads its contents automatically, but the agent can open it on request through
the Slack canvas read port (`packages/daemon/src/platforms/read-ports.ts:168`). Reading
huddle notes into the channel record automatically is a phase-0 follow-up on that port, not
new transport.

### 3.3 Google Meet

Four routes exist. The first room (§6.2) uses the third and, where the organization has it,
the second.

- **Meet Media API — unusable for a product feature.** It gives an app the conference's
  real-time audio and video over WebRTC, receive-only, and as of 2026-09-03 it is still in
  developer preview: the Cloud project, the OAuth principal, and **every participant** of the
  conference must be enrolled in the preview program, or the app gets no data. It could not
  speak even if it were open. It is the right API to move to if it reaches general
  availability, and the runner contract (§5.5) is written so a Media-API implementer replaces
  the browser one without changing the daemon.
- **Meet REST API transcripts — official, after the meeting.** `conferenceRecords.transcripts`
  and `.entries` return Google's own per-speaker transcript, and the Workspace Events API
  delivers `google.workspace.meet.conference.v2.started` and
  `google.workspace.meet.transcript.v2.fileGenerated` to a subscriber over Pub/Sub. It needs a
  Workspace plan with Meet transcription, someone in the meeting to have turned transcription
  on (there is no API to start it), and it lands after the meeting ends. It is not "joining",
  but it is the authoritative record of what was said at no speech cost, and phase 1 takes
  it where it exists (§6.2).
- **A browser participant — what every Meet bot is.** Recall.ai, Vexa, Attendee and ScreenApp
  all join Meet from a headless Chromium as an ordinary participant. Two transcript sources
  are then available. Google's **live captions**, which the participant turns on for itself
  and reads from the page: speaker-labelled, free, in Google's languages, and brittle because
  Meet's DOM is not a public API — a class name or aria label can change with any Meet
  release, which is why every open-source bot carries its selectors as data. And the call's
  **audio**, captured from the page and sent to the speech seam (§5.1): provider minutes,
  but no DOM dependence, and it works where captions do not. The runner (§5.5) offers both.
- **Admission is the real constraint.** Since March 2026 Meet's safeguarded admit flow
  screens third-party bots knocking as guests and flags them to the host as a potential
  risk; with "anyone can ask to join" off they are denied without a prompt. A participant
  signed in as a **Workspace account in the organization's domain**, on the calendar invite,
  joins without the lobby. The runner therefore holds a dedicated Google account for the
  agent — a persisted browser profile in a volume, signed in once by the operator — and
  knocks as a guest only as the fallback the console warns about.

### 3.4 Zoom

Two official routes, neither complete on its own:

- **Realtime Media Streams (RTMS)** is GA and streams per-participant audio, transcript and
  chat over WebSocket with no bot in the meeting — but it is a data pipeline, not a
  participant: an app cannot send audio or interact. It needs a Developer Pack subscription
  and account-level approval.
- **Meeting SDK for Linux** lets a headless C++ bot join as a participant, read raw audio
  per speaker, and feed a synthetic microphone. It requires the raw-data entitlement, an
  OBF token for meetings outside the account since February 2026, and a container with a
  virtual display and sound server.

Both are provider-seam material. A daemon never links the Zoom SDK.

### 3.5 Microsoft Teams

An application-hosted media bot receives and sends 20 ms audio frames through the Graph
Communications SDK, which exists only as a .NET library that must run on Windows; Microsoft
has no REST, WebSocket or other-language route and none on the roadmap. Provider seam only.

### 3.6 Feishu / Lark, Telegram, QQ

- **Feishu / Lark** exposes meeting management, cloud recordings, and Minutes (妙记)
  through its open platform; no real-time media or participant API was found. Treat this as
  unverified rather than settled (§7), and ship voice notes there in phase 0.
- **Telegram** bot accounts cannot join group voice or video chats; the libraries that do
  (tgcalls, pytgcalls) drive a **user** account over MTProto and need admin rights in the
  chat. Voice notes (`voice`, `audio`, `video_note`) are ordinary Bot API fields.
- **QQ** already delivers a voice message as an `audio/wav` attachment
  (`packages/message/src/qq-message.ts:86`).

### 3.7 Speech models

Neither runtime the daemon drives accepts audio. The Claude Messages API takes text and
images; audio input is an open feature request, and Claude Code's own voice feature is
client-side dictation into a text prompt. ACP defines an `audio` prompt block gated by
`promptCapabilities.audio`, which the daemon records
(`packages/daemon/src/acp/acp-host.ts:581-582`, `917`) but has never had a runtime
advertise (the ACP matrix profile pins `audio: false`,
`packages/daemon/test/acp-matrix/profiles.ts:492`). Speech-to-text and text-to-speech are
therefore external services in every phase, chosen per organization (§5.1), and the day a
runtime advertises `audio` the voice-note path gains a second, richer block without
changing the room design.

## 4. What already exists

The room design in §5 is mostly composition. The pieces, and where each falls short today:

| Piece                           | Where                                                                                                          | Gap for voice                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Attachment → ACP block          | `packages/daemon/src/session/attachment-block.ts:32-75`                                                        | Audio becomes an embedded blob or a `resource_link`; never an `audio` block, never text                                                |
| Telegram normalizer             | `packages/message/src/telegram-message.ts:53-54`, `75-76`                                                      | Models `photo` and `document` only; a voice note normalizes to an empty message                                                        |
| Feishu normalizer               | `packages/message/src/feishu-message.ts:64`                                                                    | Accepts `image` and `file` only; audio is dropped                                                                                      |
| Slack and Discord normalizers   | `slack-message.ts:139-155`, `discord-message.ts:74-86`                                                         | Audio passes through as a file; Discord's `duration_secs`/`waveform` and the voice-message flag are not read                           |
| Discord connection              | `packages/daemon/src/discord/connection.ts:239-249`, `138-148`                                                 | Text intents only; no `GuildVoiceStates`; invite permissions lack `CONNECT`/`SPEAK` (mirrored in `web/.../discord/invite.ts:17-24`)    |
| Agent-callable read ports       | `packages/daemon/src/platforms/read-ports.ts:190-198`                                                          | The registry that would gate a `joinVoiceChannel` tool by platform, before any connection exists                                       |
| Turn output surface             | `packages/daemon/src/platforms/turn-output.ts:82-144`; Discord registered at `daemon.ts:1372-1378`             | One surface per platform; a spoken surface is a second implementer on the same turn                                                    |
| Steering                        | `packages/daemon/src/acp/steering.ts`, `daemon.ts:11430-11463`, `daemon/steering-admission.ts`                 | Text only, ten steers per turn, ordinary user messages only — all fine for utterances                                                  |
| Channel record and observations | [message-intake.md](message-intake.md)                                                                         | Rows have no speaker timing; §5.3 adds a `voice` annotation                                                                            |
| Decision gate and provider keys | [decisions.md](decisions.md) §4, §5                                                                            | The provider-key model and data-plane rule a speech provider copies                                                                    |
| Webchat browser socket          | `packages/relay/src/relay-browser-server.ts:27`; frames `packages/protocol/src/frames/relay-daemon.ts:314-331` | JSON text only (binary frames are dropped, `packages/connection/src/ws-server-transport.ts:40`); 256 KiB cap; request-plus-ack per hop |
| Daemon packaging                | `packages/daemon/tsdown.config.ts`, `scripts/assert-self-contained.mjs`, `docker/Dockerfile:168-232`           | One self-contained bundle with no runtime dependencies; no native addons; no ffmpeg in the image; Windows CI                           |

Two of these decide where things run. The **packaging rule** is why a meeting runner is a
separate process the daemon dials (§5.5) rather than a browser inside the daemon, and why the
native Discord driver of phase 3 must use pure JavaScript or WASM codecs and DAVE
(`opusscript`, `libsodium-wrappers` or `node:crypto` AES-GCM, `@snazzah/davey`'s WASM build)
with any native acceleration kept an optional external like `bufferutil` is today. The
**text-only webchat socket** means a live microphone needs a new leg (§6.4), while everything
after transcription — the turn, the steer, the written reply — rides the socket unchanged.

## 5. Design

### 5.1 Speech providers

A daemon-side seam with two interfaces, configured per organization the way Decision
providers are ([decisions.md](decisions.md) §5): keys are saved in the console's Provider
keys page, delivered to capable daemons under a lease, and never injected into an agent's
environment. Audio bytes and transcripts travel only between the daemon and the provider;
the Control Plane sees configuration and body-free telemetry.

```ts
interface SpeechToText {
  // A live stream: PCM frames in, utterances out. `speaker` is the platform's identity
  // where the transport separates speakers, else the provider's diarization label.
  stream(opts: { sampleRate; language?; speaker? }): SttStream
  // One file: the voice-note path. Returns text plus segments with timing.
  transcribe(bytes: Buffer, mimeType: string, opts?): Promise<Transcript>
}
interface TextToSpeech {
  // Text in, audio frames out, with a cancel for barge-in.
  synthesize(text: string, opts: { voice?; language? }): TtsStream
}
```

First implementers: the OpenAI speech endpoints (one key serves both directions), Deepgram
for streaming STT, and ElevenLabs for TTS. A self-hosted `whisper.cpp` or a local TTS is a
provider that speaks HTTP to a sidecar the operator runs; it is not linked into the daemon.
Provider choice, voice, and language are agent-level settings; the room mode (§2.2) is
per conversation.

### 5.2 The voice room

A room is a daemon-owned object: one platform call the agent is in. Its driver is a new
optional facet of the daemon platform module, declared in a registry the way read ports
are, so the `joinVoiceChannel`/`leaveVoiceChannel` tools are injected only for sessions on a
platform that has one:

```ts
interface VoiceRoomDriver {
  join(target: VoiceTarget, signal): Promise<VoiceRoom>
}
interface VoiceRoom {
  readonly id: string
  readonly participants: ReadonlyMap<string, { name; isBot }>
  // One decoded PCM stream per speaker where the transport separates them (Discord); one
  // mixed stream with provider speaker labels otherwise (meeting providers).
  audioIn: AsyncIterable<{ speaker?: string; pcm: Buffer; at: number }>
  speak(audio: TtsStream): Promise<void> // resolves when played or cancelled
  cancelSpeech(): void
  leave(): Promise<void>
  onParticipants(cb): void
  onEnded(cb): void
}
```

Core owns the **voice host** around it: STT fan-in per speaker, utterance segmentation,
channel-record writes, the addressing ladder, dispatch or steer, the spoken turn output
surface, and the loop guard. The driver owns only transport: how to join, decode, encode,
and who is speaking. This is the same split as the three-facet adapter — connection and
identity in the module, sequencing in core — and it holds the two rules of the plugin
design: no platform name in core, and no manifest field, because nothing reads a room
capability before dispatch.

A room's transport runs where its driver runs: a native driver (Discord, §6.4) inside the
daemon process, which then needs UDP egress to the platform's voice servers (§7); a runner
driver (§5.5) inside the runner, with the daemon holding only the socket to it. Either way a
room is a long-lived connection like a Slack socket, not a session, and survives the agent's
turns coming and going.

### 5.3 Records

- **One utterance, one row.** The voice host writes each final utterance to the channel
  record as a `text` row whose sender is the speaker's platform identity (Discord user id)
  or a provider label, with a `voice` annotation: start and end offsets, confidence, and
  the room id. A row a speaker corrected mid-sentence is replaced before it is final; partial
  hypotheses are never recorded.
- **Session coordinate.** A room is an `append` conversation
  ([channel-session-mode.md](channel-session-mode.md)): one ongoing session per agent per
  room, keyed on the platform conversation the call belongs to — a Discord voice channel
  id, a meeting id from the provider. The room's **text companion** (the voice channel's
  chat on Discord, the linked chat thread for a meeting, the webchat transcript in the
  console) receives every written reply and the join/leave notices, so a person who was not
  on the call can read what happened and continue it in text.
- **Audio is never persisted.** No recording, no buffering beyond what segmentation needs,
  no copy on the Control Plane. Recording as a product feature is out of scope and would be
  its own design with its own consent model.
- **Announce on join.** The room announces itself — spoken where it can speak, posted to the
  meeting's own chat where it cannot yet (phase 1) — and posts the same line to the
  companion: "<agent> has joined and is transcribing". On by default, per-organization
  switch. Many jurisdictions require notice before transcription, and the notice is also how
  humans learn the agent is listening.
- **Visibility is enforceable or private.** A room session classifies under
  [session-visibility.md](session-visibility.md) §4.2 like any other session, and a runner's
  participant display names never authorize a Console reader. A native Discord room takes
  Discord's existing rules (a DM private to its initiator, a guild channel the org default).
  A meeting room (§5.5) is `private` with `ownerIdentity` set to the **active turn's trusted
  human invoker**: the sender of the latest human message the live turn has taken in — the
  message that started it, or the most recent one steered into it — at the moment the
  `joinMeeting` call runs. The tool host reads it from the pending turn the way a posting
  tool reads `deliveryThreadNow()` (`packages/daemon/src/mcp/ops/context.ts`), never from
  `SessionContext`, which is captured once at `session/new`, and never from the session's
  `triggeredBy`, which is first-wins ([channel-session-mode.md](channel-session-mode.md) §9)
  and in an `append` conversation names whoever opened the long-lived session, not who is
  asking now. The identity takes session-visibility.md's §2 form: `<platform>:<transportScope>:<senderId>`
  for a platform message (`slack:<team>:<uid>`), and for webchat `user:<userId>` from the
  `turn` frame's verified `userId` — the Control Plane principal — not the display handle or
  the email the session's trigger stores. A turn with no such human — automation, a hook, a
  cron, an agent-to-agent wake, a webchat frame from a relay too old to carry `userId` —
  has no invoker, and the tool refuses the join with that reason rather than opening a
  session someone else would own. The meeting session is not an agent-to-agent child of the
  requesting session and inherits nothing from its audience. A join with no human requester is
  `private` with a null owner — visible to no one, the fail-closed rule of §4.2 — until a
  Google binding exists: `external` with provider `google-meet`, the conference record as the
  immutable scope, and membership resolved by comparing the viewer's linked Google identity
  (§7 of session-visibility.md, fed by the console's Google sign-in) with the participants the
  agent's account can list through the REST API. That binding is the prerequisite of the
  calendar-driven join (§6.2). The companion thread receives only what the agent posts there,
  under that thread's own audience, and the voice-mode prompt says the transcript's audience
  is the requester alone, so the agent summarizes rather than pastes.

### 5.4 Spoken turn output

A `VoiceTurnOutputSurface` is a Layer-2 implementer registered beside the platform's text
surface for the same turn. It consumes the same action stream the converger produces:
`post`/`live-reply` final text is spoken once, bounded per §2.3; `notice` is spoken only in
a `medium` room; everything else is ignored. The text surface is untouched, so the written
reply lands in the companion exactly as it does today. Barge-in and the loop guard are core
concerns wired between `audioIn` and `speak`, not surface concerns.

The session prompt gains a voice-mode hint while the session is bound to a room, in the
same place platform context is injected today: the agent is told it is in a voice meeting,
who is in it, that the first three sentences of its reply will be spoken, and to put detail
after them.

### 5.5 The meeting runner seam

External meetings do not get a platform module, and the daemon never drives a browser or
links a meeting SDK (the packaging rule of §4; §6.7). A **meeting runner** is a separate
process the daemon dials — the same shape as the sandbox pod of
[cluster-spawn-and-shim.md](cluster-spawn-and-shim.md): a container beside the daemon in
Compose, or a pod the pool spawns per meeting. Its `VoiceRoomDriver` implementer (§5.2)
speaks one small protocol over one authenticated WebSocket per meeting:

```ts
// daemon → runner
join: { url; displayName; account?: 'workspace' | 'guest'; sources: ('captions' | 'audio')[] }
leave: {}
speak: { audio: TtsStream } // phase 2
// runner → daemon
state: { phase: 'knocking' | 'joined' | 'denied' | 'ended'; reason? }
participants: { list: { id; name; isBot? }[] }
caption: { speaker; text; final: boolean; at } // Meet's own captions
audio: { pcm; at } // mixed call audio, for the speech seam
chat: { from; text; at } // the meeting's text chat
```

The runner owns the browser, the account, caption and audio capture, and the meeting's chat;
the daemon owns everything after that — the channel record, addressing, dispatch, and in
phase 2 the spoken surface. A first-party runner is small: Playwright over Chromium, one page
per meeting, no GPU. The same contract admits an adopted implementer — Vexa (Apache-2.0;
joins Meet, Teams and Zoom; Whisper transcription with speaker attribution; transcripts by
polling today; speaking not in its open core) or Recall.ai as a hosted one — so an
organization swaps runners without a daemon release, and a Media-API implementer replaces the
browser one the day Google opens it (§3.3). The room's conversation coordinate is
`meeting:<provider>:<meetingId>`; its text companion is the chat the join was requested from.

A runner is configured per organization — its URL and token, and the agent's Google account
status — and the daemon reports it as a capability, `meeting-runner-v1`, so the
`joinMeeting` tool is injected only where one exists.

### 5.6 Console

Product conventions apply: no internal component names, audience language for visibility.

- Organization settings: the meeting runner (§5.5) — URL, token, the agent's account status,
  whether a guest knock is allowed as the fallback.
- Agent settings, per platform that has a room driver: enable voice, room mode default,
  speech provider, voice, language, announce-on-join, spoken-reply cap.
- Session detail: the existing transcript view shows utterance rows with a speaker label,
  a small `voice` badge and the offset; the join/leave notices are ordinary chrome rows.
- Phase 3 adds the console's own microphone and playback controls to the Playground.

## 6. Phases

### 6.1 Phase 0 — voice notes (all platforms)

The smallest change that answers "talk in voice with agent", and the speech-provider seam
every later phase with audio uses. It does not gate phase 1, which reads Meet's own captions.

1. `Attachment` gains `kind: 'voice'` plus `durationMs`. Telegram maps `voice`, `audio`
   and `video_note`; Feishu maps its audio type; Discord reads the voice-message flag;
   Slack keeps the file and reads its `transcription` object when present; QQ keeps its
   `audio/wav`.
2. The speech-provider seam (§5.1), STT first, **run at intake, above the channel record.**
   The intake ladder records first and routes second ([message-intake.md](message-intake.md)
   §5): the channel-record row is written in `onInboundOutcome`
   (`packages/daemon/src/daemon.ts:8906-8927`) before the addressing ladder and the By decision
   gate ever see the message, and both judge the row's text. A voice note transcribed only at
   prompt build would therefore be recorded as an empty message with an opaque attachment,
   could not be admitted by the name it speaks in a shared channel, and could not be judged on
   its words. Transcription is instead a normalization step in the slot Telegram thread
   canonicalization occupies today (`daemon.ts:8916-8919`): it has no store writes, and it
   produces the text step 1 records. The row's text is the transcript, marked as spoken and
   carrying the `voice` annotation of §5.3, with the original file still attached and
   materialized through the landing zone of
   [inbound-file-attachments.md](inbound-file-attachments.md) §2 once that ships. Everything
   downstream — the ladder, the Decision, admission, steering, the prompt — then treats a
   voice note exactly like a typed message.

   Conditions, so the step costs nothing where it cannot matter: it runs only when an agent
   the message can reach on this connection has an STT provider configured, and a per-agent
   setting chooses **everywhere** or **direct messages only**, because record-first means an
   observed shared channel transcribes every note whether or not one is admitted. Bytes are
   fetched through the platform read port under the existing attachment cap and a duration
   cap. When there is no provider, the download fails, or the cap is exceeded, the note is
   recorded as it is today: an attachment the agent can open, never a spoken mention. A
   runtime that advertises `audio` also gets the ACP `audio` block (`attachment-block.ts`),
   which is the one line that changes there.

   **Relay-forwarded shared bots take the host route.** The slot above is Case A of
   [message-intake.md](message-intake.md) §5, daemon-owned ingress. A shared Slack or Feishu
   bot is Case B (§6): the relay arbitrates the target from the wire message — channel
   ownership, thread continuity, the agent-slug keyword, the channel default, the bot default
   (`packages/relay/src/bot-arbitration.ts`) — before any daemon sees it, and `handleRelayIm`
   (`daemon.ts:9623-9676`) records and routes the pre-addressed copy without passing through
   `onInboundOutcome`. The relay persists nothing and calls no provider, so it cannot
   transcribe, and a voice-only note has no text for the slug or a Decision to read: agent B's
   spoken name would land on default agent A or nowhere. Phase 0 therefore gives a voice-only
   note the one-copy-to-a-host mechanism Case B already has for By decision routing:

   - The relay recognizes it from the wire alone — empty `text` and one `audio/*` attachment,
     a content-free pre-dispatch read — and forwards its single copy to the conversation's
     **transcription host** with a routing disposition, exactly as a By decision message goes
     to its evaluation host.
   - The host is the projected `evaluationDaemonId` where the conversation has one; otherwise
     the same Control Plane rule computes it for voice (the bot's default agent's daemon, else
     the earliest-created daemon among the candidate agents' daemons), restricted to daemons
     that advertised `voice-note-stt-v1` in `rd/hello` and hold an STT provider, and projected
     as a second field on `rc/bot-assign`.
   - The host downloads the bytes with the bot credential it already holds for reads,
     transcribes, records the row with the transcript as its text, runs Case A steps 2–4 on
     that text — the slug, the mention, and a bound Decision all see the spoken words — and
     distributes the frozen set: local targets admit directly, remote targets travel as
     `rd/route` with the transcript in `payload.text`, so no target transcribes twice. This is
     `hostRoutedIm` (`daemon.ts:19515`) with a transcription step ahead of its ladder, not a
     second distribution path.
   - **Where the host route is unavailable** — no daemon on the bot advertises the capability,
     or the relay or Control Plane predates the projection — the note takes today's path: the
     relay's arbitration on empty text selects the channel or bot default agent, and a spoken
     name cannot select another agent. What that agent then does depends on its own settings:
     with an STT provider configured, its daemon transcribes the note at its own intake (the
     Case A slot) for its own prompt; without one, its daemon keeps the note as an attachment
     under the no-provider rule above, whatever another agent on the bot has configured. That
     is the narrowed promise for relay platforms, and the bot's settings page says which of
     these a bot has.

3. Spoken replies: when a turn was started by a voice note and the agent's TTS is
   configured, the final reply is also synthesized and sent through the platform's
   `uploadFile` path as a voice note where the platform has one (Telegram `sendVoice`,
   Discord voice message, Slack audio file). This reuses the outbound byte path of
   [agent-authored-attachments.md](agent-authored-attachments.md) and needs no new surface.

Cost: normalizers, one intake-ladder step, the host route's transcription step and its
`rc/bot-assign` projection, one attachment-path change, a provider seam with one implementer,
and a Provider keys entry. No new connection, no codec, no packaging change.

### 6.2 Phase 1 — Google Meet: join and transcribe (the first room)

The `listen` mode of §2.2 on Google Meet: an agent joins a meeting, transcribes it into the
channel record as it happens, and hands the team the result. No speaking and no addressing;
those are phase 2.

1. **The runner** (§5.5), first-party: `docker/meet-runner` — Playwright and Chromium, a
   persisted profile volume for the agent's Workspace account — as a Compose service beside
   the daemon and a pool-spawned pod in Cloud. It joins by URL, turns captions on, and streams
   `caption` events. `audio` is behind a flag and used when captions are off or unavailable,
   or the organization prefers its own speech provider (which then needs phase 0's seam).
2. **The voice host in core** (§5.2–§5.3): the Meet `VoiceRoomDriver`; caption coalescing
   into final utterances — Meet rewrites a caption in place while a speaker talks, so a row is
   written only when its text settles; one channel-record row per utterance with the `voice`
   annotation; the session `private` to the requester (§5.3); the announce-on-join line posted
   to the meeting's chat, since nothing speaks yet.
3. **Entry points**: the `joinMeeting`/`leaveMeeting` tools, injected where a runner is
   configured, so "@agent join https://meet.google.com/…" in Slack or the console works; the
   active turn's trusted human invoker (§5.3) becomes the session owner, a turn without one is
   refused, and the requesting thread is the text companion that receives the joined, denied,
   and left notices. A calendar-driven join — the Workspace
   Events `conference.v2.started` event for meetings the agent's account is invited to, on the
   trigger seam — is phase 1b: it has no human requester to own the session, so it waits on
   the Google identity binding of §5.3.
4. **The result**: when the runner reports `ended`, the voice host activates the agent once
   with a meeting-ended prompt, so the agent posts what a meeting produces — a summary,
   decisions, action items, links to the work it was asked for — into the companion thread,
   and the whole transcript stays readable in the session view. Where the organization has
   Meet transcription, the official `transcript.v2.fileGenerated` event fetches Google's
   transcript into the same record as the authoritative copy (§3.3). Google serves transcript
   entries to a meeting-space owner or participant, so the agent's account can fetch them for
   a meeting the runner joined or a space the account created; an invitation it never attended
   yields the event without the artifact, and the record then holds only what the runner heard.
5. **Console**: the organization's runner settings, a meetings row on the agent, and the
   speaker label and offset in the session transcript view.

Behind a `voice.meet` feature flag until the caption path has run against Meet's DOM across
one release. The runner's selectors are versioned with the runner, not the daemon, so a Meet
UI change ships as a runner update.

### 6.3 Phase 2 — Google Meet: addressed and speaking

The full room on Meet: the `addressed` and `talk-back` modes, the runner's `speak` (synthesized
audio into a virtual microphone, the PipeWire or PulseAudio virtual-device shape every speaking
bot uses), the spoken turn output surface (§5.4), acknowledgement on admission, barge-in, and
the loop guard on mixed audio — the transcriber is muted while the agent speaks and caption
rows attributed to the agent's own display name are dropped. The voice-mode prompt hint turns
on. Phase 0's TTS seam is the prerequisite.

### 6.4 Phase 3 — Discord voice channels and the console

- **Discord**, the one native driver. `@discordjs/voice` with `@snazzah/davey`; the
  `GuildVoiceStates` intent; `CONNECT` and `SPEAK` in both copies of the invite permissions;
  pure-JS/WASM Opus and encryption with any native speedup kept external, absent on platforms
  that cannot load it, and skipped by the Windows unit suites. One decoded PCM stream per
  speaker with bot speakers dropped at the source, Opus playback with cancel, and a
  `/voice join|leave` slash command beside the existing command chrome. The voice host, the
  spoken surface, and the prompt hint are phase 1 and 2 work reused unchanged. Behind a
  `voice.discord` flag until the receive path has run in production for a release (§3.1).
- **Webchat**, one human in the console. Audio cannot ride the webchat socket (§4). The
  recommended shape is a media leg beside it: the browser sends 20 ms Opus frames over a
  second WebSocket at the relay, authenticated with the same conversation token, which the
  relay forwards to the owning daemon over a capability-gated binary `rd/*` stream, and
  playback returns the same way; the daemon runs the same voice host with a `webchat` room
  driver, the relay persists nothing, and the Control Plane carries nothing. The fallback is
  browser-side recognition and synthesis sending ordinary `turn` and `steer: true` frames —
  zero server audio, uneven quality and privacy, worth shipping as the no-provider mode. A
  webchat conversation has one human owner, so this is the issue's first ask done live, not
  a group room.

### 6.5 Phase 4 — Zoom, Teams, and huddles

Through the runner seam (§5.5): Zoom and Teams via the first-party runner's browser path or an
adopted runner; Zoom's native SDK never in the daemon; Slack huddles only with a runner the
organization brings and a signed-in seat it accepts the terms of (§3.2). Calendar-driven
joins from phase 1b extend to these platforms' invites.

### 6.6 Sequencing and dependencies

```
phase 0 voice notes (speech providers) ─────────────┐
phase 1 Meet join + transcribe (runner, voice host) ─┴─► phase 2 Meet addressed + speaking
                                     │                          └─► phase 3 Discord + console
                                     └─► phase 4 Zoom / Teams / huddles (same runner)
```

Phases 0 and 1 are independent and run in parallel; phase 2 needs both; phases 3 and 4 need
only the voice host and the runner.

### 6.7 Deliberately not done

- **No browser automation in the daemon.** It lives in the runner, a separate process the
  daemon dials (§5.5), for Meet and every other meeting product.
- **No Meet Media API** until it leaves developer preview (§3.3); the runner contract is the
  seam it will replace.
- **No recordings** and no audio persistence anywhere (§5.3).
- **No speech-to-speech model in place of the agent.** A fast voice model that answers
  without running the ACP turn is a different product; the agent's value is the work it
  does, and a fast acknowledgement is all the room needs (§2.3).
- **No Telegram group calls** and **no Feishu meetings** until an official bot route exists.
- **No manifest field.** Room support is a host-contract facet; nothing reads it before
  dispatch.

## 7. Open questions to verify before implementation

1. Meet's caption DOM: which selectors hold (the captions region by role and aria label, or
   obfuscated class names), how often Meet changes them, and the coalescing rule for a caption
   rewritten in place.
2. The agent's Google account: whether Workspace administrators will create a dedicated user
   per agent or one per organization shared by its agents, the 2-step-verification policy for
   it, and how the runner re-authenticates a persisted profile Google signs out.
3. Whether Google's bot screening (§3.3) extends to signed-in Workspace participants that
   behave like bots — no camera, no microphone — or only to guests, as the March 2026 change
   states.
4. Meet REST transcripts: which Workspace editions the organization's tenants have, and
   whether an Events subscription held by the agent's account covers every meeting it is
   invited to.
5. The Google binding (§5.3): whether the console's Google sign-in identity can join the
   viewer's identity set the way a linked Slack account does, and whether
   `conferenceRecords.participants` returns an account id a viewer's identity can be matched
   against, not only a display name.
6. The pool: a runner pod per meeting under the sandbox namespace's NetworkPolicy — Meet needs
   WebRTC (UDP) egress the sandbox may not allow today, and the same question applies to a
   native Discord driver in a daemon pod ([k8s-daemon-pool.md](k8s-daemon-pool.md) D3 covers
   only the shim).
7. Vexa as an adopted runner: which account its bot joins with, and whether its polling
   transcript API is acceptable until its WebSocket stream ships.
8. Discord's receive path under DAVE in `@discordjs/voice` 0.19+, and whether Discord's
   developer terms say anything about bots consuming voice.
9. Whether a WASM DAVE and Opus stack keeps up with a busy room on the daemon's CPU budget.
10. Feishu / Lark: an official real-time media or participant API, if one exists for
    enterprise plans.
11. Speech-provider cost per meeting hour at streaming STT rates for the audio path, and
    whether the Cloud deployment funds it through the same credit path as Decisions.
12. Whether `claude-agent-acp` or `codex-acp` plan to advertise `promptCapabilities.audio`.
13. Consent requirements for automatic transcription in the jurisdictions Cloud serves, beyond
    the announce-on-join default.

## 8. Risks

- **Meet's DOM moves.** A Meet release can break caption reading overnight. Mitigation:
  selectors as versioned runner data, a canary meeting in CI against the live product, the
  audio path as the fallback source, and the official transcript as the record of last resort.
- **Google tightens admission.** The March 2026 change flagged guest bots; a later one could
  reach signed-in participants. Mitigation: the Workspace account on the invite, the REST
  transcript route that needs no participant, and a console status that says when a join was
  denied and why.
- **Account lockouts.** A dedicated Google account that signs in from a container is exactly
  what Google's abuse systems watch. Mitigation: one persisted profile, a stable egress
  address, and a re-authentication flow the operator can complete from the console.
- **Undocumented receive on Discord** (§3.1). Mitigation: the feature flag and a health probe
  that detects silent decryption failure.
- **Speech recognition mangling names** makes `addressed` mode miss or over-trigger.
  Mitigation: aliases, the Decision fallback, and the talk-back mode for one-on-one use.
- **A room holds a socket open for hours.** Reconciliation, drain, and upgrade flows treat it
  as a platform connection; an upgrade mid-meeting drops the agent from the call, which the
  daemon must announce in the companion.
- **Loops between agents** in one room (§2.3). Speaker identity on Discord makes this cheap;
  caption speaker names are weaker, so a meeting room defaults to one agent.
- **Provider dependence** for the audio path and for speaking. Captions and the official
  transcript keep phase 1 provider-free; the console must say plainly what an organization
  without a provider gets in later phases.
- **Cost surprise.** Streaming STT for a room nobody addresses costs the same as one that is
  used. Rooms default to leaving after a configurable idle period, and captions are preferred
  where they exist.

## 9. Recommended sequencing

1. Phase 1 first: Meet join and transcribe through the first-party runner, captions first and
   audio behind a flag, with the meeting-ended activation as the visible result. The voice
   host it builds is the room model every later phase reuses. Phase 0 runs in parallel — the
   speech seam the audio path and phase 2 need, plus voice notes on five platforms.
2. Phase 2 once the host is stable: speaking on Meet, which turns the note-taker into the
   participant the issue asks for.
3. Phase 3: the Discord native driver and the console microphone, both drivers on the same
   host.
4. Phase 4 when Zoom or Teams demand appears; nothing in it changes the host.

## 10. Sources

- [Issue #2361](https://github.com/agentconnect-md/agentconnect/issues/2361)
- Google Meet: [Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview),
  [concepts](https://developers.google.com/workspace/meet/media-api/guides/concepts),
  [REST API transcripts](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts),
  [transcript entries](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries),
  [Meet events overview](https://developers.google.com/workspace/meet/api/guides/events-overview),
  [controlling meeting access](https://support.google.com/a/users/answer/11989526),
  [Google Meet update to stop bots joining meetings](https://www.neowin.net/news/google-meet-gets-a-new-update-to-stop-bots-from-joining-meetings/),
  [Recall.ai Google Meet FAQ](https://docs.recall.ai/docs/google-meet-faq),
  [Recall.ai Google Meet bot](https://github.com/recallai/google-meet-meeting-bot),
  [caption capture from Meet's DOM](https://github.com/vincelamm/gMeetTranscriptCapture),
  [OpenClaw caption coalescing](https://github.com/openclaw/openclaw/pull/150638)
- Meeting-bot runners: [Vexa](https://github.com/Vexa-ai/vexa),
  [Recall.ai meeting-bot](https://github.com/recallai/meeting-bot),
  [Attendee](https://github.com/attendee-labs/attendee),
  [ScreenApp meeting-bot](https://github.com/screenappai/meeting-bot),
  [Meeting BaaS speaking bots](https://www.meetingbaas.com/en/api/speaking-bots-api)
- Discord: [End-to-End Encryption for Audio and Video](https://support.discord.com/hc/en-us/articles/25968222946071-End-to-End-Encryption-for-Audio-and-Video),
  [DAVE protocol](https://daveprotocol.com/),
  [discord.js DAVE support PR](https://github.com/discordjs/discord.js/pull/10921) and
  [issue](https://github.com/discordjs/discord.js/issues/10735),
  [@discordjs/voice](https://www.npmjs.com/package/@discordjs/voice),
  [voice messages API documentation](https://github.com/discord/discord-api-docs/pull/6082)
- Slack: [Recall.ai on Slack huddles](https://www.recall.ai/product/slack-huddles-api),
  [OpenClaw huddle plugin PR](https://github.com/openclaw/openclaw/pull/159879),
  [claw-huddle](https://github.com/jlgrimes/claw-huddle),
  [Record audio and video clips in Slack](https://slack.com/help/articles/4406235165587-Record-audio-and-video-clips-in-Slack),
  [Use AI to take huddle notes](https://slack.com/help/articles/31377193680019-Use-AI-to-take-huddle-notes-in-Slack)
- Zoom: [Realtime Media Streams](https://developers.zoom.us/docs/rtms/),
  [Meeting SDK Linux raw recording sample](https://github.com/zoom/meetingsdk-linux-raw-recording-sample)
- Microsoft Teams: [Real-time media calls and meetings for bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)
- Telegram: [tgcalls](https://github.com/MarshalX/tgcalls)
- Feishu: [Meeting solutions on the open platform](https://open.feishu.cn/solutions/detail/meetings?lang=zh-CN)
- Speech and Claude: [audio input feature request](https://github.com/anthropics/anthropic-sdk-python/issues/1198),
  [Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation)
