# Running the daemon in Kubernetes

Applies to the `agentconnect` namespace. The agent-sandbox CRDs
(`agents.x-k8s.io`, `extensions.agents.x-k8s.io`) must already be installed.

## Why the `runtimes` block in the config is not optional

`--k8s` refuses package launchers. The public ACP registry distributes both
runtimes as `npx` packages, and a runtime fetched at spawn time would mean the
image pin says nothing about what actually runs — and would need registry egress
from a sandbox that should have none. So the ids have to be mapped to the
executables the runtime image really ships:

```json
"runtimes": {
  "claude-acp": { "command": "claude-agent-acp", "args": [], "env": [] },
  "codex-acp":  { "command": "codex-acp",        "args": [], "env": [] }
}
```

Without it the daemon starts, connects, and advertises **no runtimes** — so the
Control Plane never assigns it an agent, and nothing looks broken.

## Apply

```bash
# 1. The config, including the API key. A Secret rather than args: arguments are
#    visible in `kubectl describe pod` and in the container's process list.
cp deploy/k8s/config.example.json /tmp/config.json
$EDITOR /tmp/config.json # set controlPlane.key
kubectl -n agentconnect create secret generic agentconnect-daemon-config \
  --from-file=config.json=/tmp/config.json
shred -u /tmp/config.json

# 2. Everything else.
kubectl apply -f deploy/k8s/00-rbac.yaml
kubectl apply -f deploy/k8s/10-runtime-table.yaml
kubectl apply -f deploy/k8s/20-service.yaml
kubectl apply -f deploy/k8s/40-sandbox-pool.yaml
kubectl apply -f deploy/k8s/30-deployment.yaml
```

## Keeping the runtime table honest

`10-runtime-table.yaml` must describe the image `40-sandbox-pool.yaml` pins. The
table is generated inside that image, so regenerate it from the image itself
rather than editing by hand:

```bash
docker run --rm --entrypoint cat \
  ghcr.io/agentconnect-md/runtime-sandbox: < TAG > \
  /opt/agentconnect/runtime/k8s-runtimes.json
```

A table that disagrees with the image makes the daemon advertise a runtime
version nobody can run.

## Checking it works

```bash
kubectl -n agentconnect logs deploy/agentconnect-daemon | grep -E 'k8s:|runtimes ready'
```

Expect `k8s: execution plane ready — shim endpoint on :8085` and a non-empty
`runtimes ready:`. An empty one means the table or the `runtimes` mapping is
missing — see above.

Then assign an agent and send it a message. The daemon creates a
`SandboxClaim` named `agent-<agentId>`:

```bash
kubectl -n agentconnect get sandboxclaims,sandboxes
kubectl -n agentconnect logs deploy/agentconnect-daemon | grep -E 'cluster:|shim:'
```

`shim: bound agent <id> generation <n>` is the handshake completing — the pod
dialled back, its projected token passed TokenReview, and it was matched to the
launch that started it.

## Known gaps in this stage

- **GitHub-App git will not work in a sandbox yet.** The credential helper path
  is still derived from a daemon-local shim path that does not exist in the pod.
  Agents on public repos or without git are unaffected.
- **Direct provider egress.** No egress proxy: sandboxes reach providers
  directly, and provider keys are handed to the runtime rather than held by a
  proxy.
- **Default runtimeClass.** No gVisor/Kata. `runtimeClassName` on the template's
  pod spec is where that goes when it lands.
