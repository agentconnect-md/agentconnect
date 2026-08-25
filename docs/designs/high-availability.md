# High-Availability Design Principles

> Status: Living application design contract
>
> Related:
> [architecture.md](architecture.md),
> [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md),
> [shared-bot-relay.md](shared-bot-relay.md), and
> [control-plane-implementation.md](control-plane-implementation.md)

This document records the environment-independent availability properties that
AgentConnect's architecture is expected to preserve. Capacity planning,
infrastructure topology, and incident procedure are not part of this
application contract.

## Architecture Invariants

### The Control Plane is not on the message hot path

An established daemon remains the unit that receives messages, runs the agent,
and sends replies. Control Plane unavailability may delay configuration and
observability, but live platform message bodies and ACP update streams must stay
on the daemon/relay data plane. Authorized, bounded BFF reads may proxy
daemon-local content through the Control Plane without persistence.

### Daemons fail independently

Each daemon owns its local runtime processes, workspaces, transcripts, and
channel connections. A daemon failure must not directly terminate work owned by
another daemon.

### Relays are transit-only

A relay may route shared integration traffic, hooks, or webchat traffic, but it
must not become durable storage for message bodies. Routing state must be
reconstructible from authoritative control data.

### Control state is fenced and convergent

Reconnects and retries are normal. Control operations must be idempotent where
practical, and ownership-changing operations must use epochs or equivalent
fences so that stale processes cannot regain authority.

### Secrets never enter telemetry

Credentials may cross authenticated, encrypted control channels only where the
protocol explicitly requires them. Logs, metrics, traces, errors, and
operator-facing diagnostics must not contain secret values.

## Failure Domains and Required Behavior

| Failure domain                        | Required externally visible behavior                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Control Plane process or network path | Existing daemon-local work continues; reconnect uses bounded backoff and complete reconciliation                  |
| Daemon process or host                | Impact is limited to work owned by that daemon; loss is detectable and represented explicitly                     |
| Relay process or route                | Other independent routes continue; accepted work is not silently reported as delivered                            |
| Database or control-state store       | The system fails closed for authority changes and avoids reconnect amplification                                  |
| Identity or secrets provider          | Existing in-memory sessions degrade predictably; new operations return typed failures without leaking credentials |
| External channel or Git provider      | Retries are bounded and idempotent where supported; permanent failure remains observable                          |
| Slow or disconnected consumer         | Buffers are bounded, backpressure is enforced, and overflow has an explicit outcome                               |

## Reliability Requirements

### Detection and observability

- Liveness must distinguish a clean shutdown, a transient disconnect, and an
  unreachable component.
- Operators need metrics for connection state, authentication rejection,
  routing failure, queue pressure, dropped work, and reconciliation lag.
- Alerts should describe the affected plane and scope without including tenant
  content or credentials.

### Reconnection and convergence

- Clients use exponential backoff with jitter and a finite upper bound.
- Authentication failures are classified separately from transient transport
  failures.
- Reconnection performs an authoritative snapshot reconciliation rather than
  relying on missed incremental events.
- Duplicate frames, retries, and stale connections cannot create two owners for
  the same fenced resource.

### Backpressure and delivery

- Every network writer has a bounded high-water mark and a defined overflow
  policy.
- An acknowledgement means the receiver has accepted responsibility according
  to the relevant protocol; work rejected during drain or overload must receive
  a typed negative result.
- Durable delivery mechanisms use stable idempotency keys. Best-effort paths
  make potential loss visible rather than presenting it as success.

### Graceful shutdown

- A component becomes unready before it drains active connections.
- New work is rejected or redirected during drain.
- In-flight work is given a bounded completion window.
- Clean shutdown is represented differently from an unexpected loss so that
  reconnect and alert policy can respond appropriately.

### Multi-instance control services

Running multiple instances must not depend on an in-process connection registry
or event bus for correctness. Cross-instance control delivery, revocation,
online-state reads, and live-event publication require shared coordination and
fencing before horizontal scaling is enabled.

### Credential rotation

Rotation must support an overlap window or another reversible transition.
Operators must be able to validate new credentials before retiring old ones,
and a failed rotation must have a documented recovery path that does not
require exposing secret material.

## Validation

Application implementation changes that affect availability should include the
smallest useful evidence for the changed invariant:

- deterministic unit tests for fencing, retry classification, and bounded
  queues;
- integration tests for reconnect reconciliation and cross-instance control
  delivery when those paths change;
- failure-injection tests that assert typed outcomes rather than silent loss;
- compatibility checks for mixed-version clients when wire behavior changes.

Infrastructure-specific drills, thresholds, replica placement, provider
failover, backup restoration, and incident-response steps are outside
application-level validation.

## Review Checklist

Before merging an availability-affecting change, verify:

1. Does it preserve the daemon-local message and ACP data boundary?
2. Is the failure domain no broader than necessary?
3. Are retries bounded, idempotent, and classified?
4. Can stale or duplicate actors regain authority?
5. Can overload or drain produce a false-success acknowledgement?
6. Are all secret-bearing values excluded from logs and diagnostics?
7. Is the behavior observable without coupling it to environment-specific details?
