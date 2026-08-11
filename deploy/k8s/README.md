# Running the daemon in Kubernetes

Applies to the `agentconnect` namespace. The agent-sandbox CRDs
(`agents.x-k8s.io`, `extensions.agents.x-k8s.io`) must already be installed.

## What the config carries, and what it no longer has to

`config.example.json` is the Control Plane connection and nothing else — the URL
and the API key. Those are the only facts about this deployment that cannot be
discovered: one is a secret, and a secret cannot be probed.

It used to also need a `runtimes` block mapping each id to an executable, because
`--k8s` refuses package launchers and the registry distributes these runtimes as
`npx` packages or downloaded archives. That mapping is gone: the image now publishes
the command it installed — with its arguments, which `opencode` needs — alongside the
version and ACP capabilities, and the daemon takes it from there. How a runtime is
launched is a property of the image that ships it, not something daemon-side YAML
should assert about a filesystem it cannot see.

One consequence of dropping it: the daemon still projects the probed ids onto the
public ACP registry for their identity, served cache-first from
`<root>/acp_registry.json`. A first boot with the registry unreachable and no cache
leaves the ids unresolved until a later start warms it. An operator `runtimes` entry
still overrides everything, so it remains the escape hatch for an air-gapped cluster.

## Pinning the images

Both manifests carry `<IMAGE_TAG>`. The tag must be built from a commit that
contains BOTH the live-probe protocol and the pod-environment fix — `v1.41.0-rc.47`
has the first but not the second, so pinning it reproduces a Codex failure inside
the sandbox. Use the same tag for both images: a daemon that probes paired with a
shim that cannot serve `probe` advertises nothing, and a shim that can paired with
a daemon that reads a file finds no file.

If you move the tag, check the shim actually serves the capability first:

```bash
TAG=v1.41.0-rc.NN
docker run --rm --entrypoint sh ghcr.io/agentconnect-md/runtime-sandbox:$TAG \
  -c "grep -c generate-runtime-table /opt/agentconnect/shim/index.js"
```

`1` means the probe handler is bundled in; `0` means that image predates it and
the daemon will say so rather than failing vaguely.

Grep for the string `probe` instead and you will mislead yourself — the bundler
emits capability names with double quotes, so a single-quoted pattern reports `0`
for an image that is perfectly fine. That mistake is why this command matches the
generator path the handler references rather than the capability name.

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
# The controller must accept our label domain before it will create any Sandbox,
# and it reads that config only at startup. It lives in the CONTROLLER's namespace:
NS=$(kubectl get deploy -A -o jsonpath='{range .items[?(@.metadata.name=="agent-sandbox-controller")]}{.metadata.namespace}{end}')

# Merge, do not clobber: this key REPLACES the allowlist, so applying the file blind
# would revoke any domain already in there (including the built-in fallback).
kubectl -n "$NS" get cm agent-sandbox-config -o jsonpath='{.data.allowed-label-domains}' 2> /dev/null \
  || kubectl -n "$NS" apply -f deploy/k8s/05-label-allowlist.yaml
kubectl -n "$NS" rollout restart deploy/agent-sandbox-controller

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

## Two things the cluster decides, not this repo

**The label allowlist** (`05-label-allowlist.yaml`). Without it the controller
rejects our claim with `InvalidMetadata` and never creates a Sandbox. It is shared
config read at controller startup — merge, do not overwrite, and check for running
sandboxes before the restart.

**The storage class.** `40-sandbox-pool.yaml` pins `standard` (a cluster-wide
CSI). The cluster default here is `local-path`, which failed with
`no local path available on node sea-admin` — a local provisioner has no path on
every node, so the workspace fails to bind wherever the scheduler happens to put
the pod. Pick a class that provisions cluster-wide; a node-local one also ties the
sandbox to one node for the volume's life, which a resumable workspace should not
be.

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
