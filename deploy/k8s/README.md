# Running the daemon in Kubernetes

Applies to the `agentconnect` namespace. The agent-sandbox CRDs
(`agents.x-k8s.io`, `extensions.agents.x-k8s.io`) must already be installed.

## Why the `runtimes` block in the config is not optional

`--k8s` refuses package launchers. The public ACP registry distributes the
runtimes as `npx` packages or downloaded archives, and a runtime fetched at
spawn time would mean the image pin says nothing about what actually runs — and
would need registry egress from a sandbox that should have none. So the ids
have to be mapped to the executables the runtime image really ships:

```json
"runtimes": {
  "claude-acp": { "command": "claude-agent-acp", "args": [], "env": [] },
  "codex-acp":  { "command": "codex-acp",        "args": [], "env": [] },
  "opencode":   { "command": "opencode",         "args": ["acp"], "env": [] }
}
```

Without it the daemon starts, connects, and advertises **no runtimes** — so the
Control Plane never assigns it an agent, and nothing looks broken.

## Pinning the images

Both manifests carry `<IMAGE_TAG>` rather than a version, deliberately: the tag
has to be one built from a commit that contains the probe protocol, and no such
release existed when these files were written. Pinning an older tag produces a
daemon that starts, connects, and advertises nothing forever — which looks
healthy.

Use the same tag for both, and check it before applying:

```bash
TAG=v1.41.0-rc.NN
docker run --rm --entrypoint sh ghcr.io/agentconnect-md/runtime-sandbox:$TAG \
  -c "grep -c \"'probe'\" /opt/agentconnect/shim/index.js"
```

A count of `0` means that image's shim predates the probe capability and will
reject the daemon's request. The daemon says so explicitly if it happens.

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
kubectl apply -f deploy/k8s/20-service.yaml
kubectl apply -f deploy/k8s/40-sandbox-pool.yaml
kubectl apply -f deploy/k8s/30-deployment.yaml
```

## Where the runtime list comes from

Nowhere in these manifests. On startup the daemon brings up one sandbox under a
reserved id, asks it over the shim which runtimes it provides — the pod runs the
image's own generator, which drives each runtime through ACP `initialize` — then
tears that sandbox down and advertises the answer.

That is deliberate. A list compiled into the daemon would tie a runtime version
bump to a daemon release and describe an image the daemon never opened. A list in
a ConfigMap is a copy, and a copy left behind when the image tag moves is silent:
the daemon advertises a version nobody can run and looks perfectly healthy. The
only source that cannot drift is the running pod.

Consequences worth knowing:

- Between boot and the probe returning, the daemon advertises **no runtimes**, so
  the Control Plane assigns it nothing. On a cold pool that wait is a pod start.
- If the probe fails, the daemon keeps advertising nothing and says so, rather
  than accepting agents it cannot launch.
- Changing the runtime image is a `40-sandbox-pool.yaml` edit plus a daemon
  restart. There is nothing else to keep in sync.

## Checking it works

```bash
kubectl -n agentconnect logs deploy/agentconnect-daemon | grep -E 'k8s:|runtimes ready'
```

Expect `k8s: execution plane ready — shim endpoint on :8085`, then
`runtimes: probing a sandbox …` and `runtimes ready (probed): claude-acp@…`.

An empty probed list means the `runtimes` mapping above is missing — the ids
resolved through `npx` and were dropped. A probe that fails outright is usually
the pool: check `kubectl -n agentconnect get sandboxclaims` for
`agent-ac-runtime-probe`.

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
