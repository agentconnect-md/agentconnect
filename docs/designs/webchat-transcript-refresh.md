# How a Webchat Session Page Stays Current

> **Status:** Implemented.
> **Builds on:** [webchat-multi-agents.md](webchat-multi-agents.md) (the reply stream, `postId`,
> attach and resume), [webchat-threads.md](webchat-threads.md) (§5.1 handed roots, §6 the
> coordinator page and its thread panel), [high-availability.md](high-availability.md)
> (`session-activity` forwarding).
> **Primary implementation areas:** `packages/web` (`lib/session-transcript.ts`,
> `lib/use-session-transcript.ts`, `components/console/task-thread.ts`, the session page and the
> thread panel), `packages/relay` (the turn ack).

## 1. Summary

A webchat session page that has transcript rows draws the rows, and draws over them only what the
rows cannot hold yet. The page reads new rows whenever the daemon says the transcript changed, also
while a turn runs. So what the page shows converges to what a reload would show, within about a
second, and nothing it shows needs a reload to correct.

Before this, the page drew a turn from its live stream until the turn ended, then had to decide,
from the words and times of the rows it read, which live steps those rows replaced. When that
decision missed, the live steps stayed until a reload. A coordinator's turn on a message it handed to
a task was one such miss: its live work stayed on the main timeline, while the saved rows put it in
the task's thread.

This applies to pages backed by rows: an adopted webchat session, a coordinator page and its
thread panel. A fresh playground conversation, which has no rows to read yet, still draws its live
stream alone. An AHP conversation rebuilds its live steps from its own snapshot and retires them
with its own merge, but its page reads and draws them the same way.

## 2. What each source draws

The daemon writes reasoning and tool rows while a turn streams: a tool row on its first update and
again on each change, a reasoning row when its thinking block ends, a plan row on every revision.
The person's message is written when the daemon takes it in. Reply text is written per segment when
the turn ends, before its `done` frame, each segment under the `postId` the stream already named.

| Content                                              | Drawn from                                           |
| ---------------------------------------------------- | ---------------------------------------------------- |
| A sent message                                       | The row; a local copy until the row is read          |
| Reasoning, tool calls, the plan                      | The rows only                                        |
| Reply text                                           | The stream while it streams; the row once saved      |
| Agent posts, shared images, task cards               | The rows; the live copy retires by its `postId`      |
| Questions, approvals, forms, app frames              | The live card, keyed by request or app id, as before |
| Startup waits, local errors, a steer's pending state | The stream only; nothing saves them                  |
| Threads and handed roots                             | The rows only                                        |

The page therefore no longer draws live reasoning, tool or plan steps (`liveOverlay`). They reach it
through the rows within about a second, reasoning a block at a time.

## 3. Retiring a live copy

A read retires live copies by identity, never by inference (`retireLiveOverlay`):

- **A sent message** retires when a row carries its `postId`. The relay mints that id for every
  turn and now returns it in the accepted ack, which the console stamps on its copy. A message an
  older relay named no post for falls back to matching its row by words and time.
- **A reply segment** retires when a row carries its `postId`.
- **Anything else a lane streamed** retires on the first read that began after the lane's `done`.
  The reply's rows are written before `done`, so that read holds whatever the turn saved. Text the
  turn never posted, such as a coordinator's words before it hands the message to a task, or a
  superseded answer, goes then too.
- A local warning and a standing notice stay; they are not the turn's output.

Post ids are matched against every row the visit has read, not only the latest increment, so a copy
named after its row was read still finds it. The other rules apply in the place the read covered:
the root's read retires the root's copies, a thread's read retires that thread's.

## 4. When the page reads

The daemon already signals every transcript change: `scheduleSessionActivity` sends a body-free
`event/session-activity` with the session and its new revision, at most every 250 ms per session,
including a handed root's revision bump. The Control Plane forwards it to the console's session
event stream. The page reads the tail on:

- each signal for its session, mid-turn included;
- a turn's end, its last lane's `done`;
- the event stream reconnecting, and the page being shown again;
- a 15 s fallback while a turn runs, for a signal that never arrived.

One read is in flight at a time, a signal during it reads once more after it, and reads are at least
a second apart. A hidden page reads nothing. The thread panel reads its record on the signals of the
coordinator's session and of the task holding the thread, with the same one-second gap, and falls
back to every 15 s while the thread's task runs and every 30 s otherwise.

## 5. Trade-offs

- Tool calls and plan updates appear about 0.3 to 1 s after the runtime reports them, reasoning when
  its block ends; reply text still streams as it is written.
- An active turn costs one transcript read per second per open page, each a Control Plane proxy to
  the owning daemon. Idle and hidden pages cost nothing beyond the fallback.
- Until a reply segment is saved, it streams below the turn's saved work as a block of its own.
