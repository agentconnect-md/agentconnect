# Running the daemon in Kubernetes

Applies to the `agentconnect` namespace — one daemon, applied by hand, no
operator. The managed path is `charts/operator`, which installs the agent-sandbox
stack itself under `installCRD` and provisions per-org envelopes from
`AgentConnectOrg` resources.

These manifests still need agent-sandbox (`agents.x-k8s.io`,
`extensions.agents.x-k8s.io`) in the cluster. If it is not there, apply the same
pinned release the chart vendors, so both paths run the same version:

```bash
kubectl apply -f charts/operator/vendor/agent-sandbox.yaml
```

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

One consequence of dropping it: the daemon still projects the probed ids onto the
public ACP registry for their identity, served cache-first from
`<root>/acp_registry.json`. A first boot with the registry unreachable and no cache
leaves the ids unresolved until a later start warms it. An operator `runtimes` entry
still overrides everything, so it remains the escape hatch for an air-gapped
cluster.

## Pinning the images

Both manifests carry `<IMAGE_TAG>`. The tag must be built from a commit that
contains all three of: the live-probe protocol, the pod-environment fix, and the
image-published runtime command. `v1.41.0-rc.47` has only the first, so pinning it
reproduces a Codex failure inside the sandbox and advertises no runtimes. Use the same tag for both images: a daemon that probes paired with a
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
# The controller must accept our label domain before it will create any Sandbox.
# (charts/operator ships this as a ConfigMap; a hand-applied stack has to merge
# into whatever allowlist the cluster already has, which is what the script does.)
# This MERGES into whatever is already allowed and finds the controller's own
# namespace; it prints the restart command rather than running it, because the
# controller is shared and a restart interrupts reconciliation for every tenant.
./deploy/k8s/allow-label-domain.sh

# STOP HERE and run the restart the script printed. The controller holds the
# allowlist in memory from its own startup, so until it restarts it still rejects
# our claims — and the daemon's probe below would launch against that stale state
# and report no runtimes.

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

**The label allowlist** (`allow-label-domain.sh`). Without it the controller
rejects our claims with `InvalidMetadata` and never creates a Sandbox. It is a
script rather than a manifest for two reasons: the key REPLACES the allowlist, so
an apply would revoke whatever is already there — including the controller's own
`sandbox.users.io` fallback — and a manifest that names its own namespace cannot be
relocated to the controller's with `-n`. Upstream installs the controller into
`agent-sandbox-system`; this cluster runs it in `agentconnect`.

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

An empty probed list means the image did not report a launchable runtime — most likely an image predating the command-publishing change, whose ids still resolve through `npx` and are dropped.

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

- **`gh` is not in the runtime image.** Git authenticates through the shim's
  `gitcred` tunnel, but the `gh` wrapper's per-repo `GH_TOKEN` path needs the
  `gh` CLI in the sandbox and is not wired; an agent that shells out to `gh`
  gets whatever `gh` it does not find.
- **Skills are not installed for a cluster agent.** Acquisition, the ledger and
  stale-executable removal are local-filesystem work, so pointing them at a pod
  path would write onto the daemon's own disk.
- **Session-isolated workspaces are refused** under `--k8s`, loudly: a logical
  session worktree needs `worktree add` in the sandbox and a retention GC that
  reads the pod's tree.
- **The MCP bridge is not tunnelled.** The tunnel supports it, but the in-pod
  `agentconnect mcp-bridge` that would dial it is not in the image.
- **Direct provider egress.** No egress proxy: sandboxes reach providers
  directly, and provider keys are handed to the runtime rather than held by a
  proxy.
- **Default runtimeClass.** No gVisor/Kata. `runtimeClassName` on the template's
  pod spec is where that goes when it lands.
