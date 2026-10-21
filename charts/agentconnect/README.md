# AgentConnect Helm chart

Deploys the AgentConnect stack on Kubernetes. A default install carries the whole product:
the Control Plane (REST BFF + daemon WebSocket gateway), the web console, the Setup Server,
the relay ingress pool, the install-wide daemon pool with its agent-sandbox runtime plane
(three pre-warmed sandboxes), and open-connector. The centralized Mem0 external-memory
wrapper/backend is the one opt-in extra, and each default-on component has a values switch
to turn it off.

For a first local evaluation prefer the Docker Compose stack in the repository root;
this chart is the production shape.

## Installing

The chart is published to GHCR as an OCI artifact on every AgentConnect release. The
chart version tracks the release (`1.2.3`, `1.2.3-rc.4`), and `appVersion` is that
release's image tag — so an install that sets no `image.tag` runs the release whose
chart it picked. Release candidates, charts and images alike, may be pruned from GHCR
after 14 days, so install a stable version.

Use a version only after its Release workflow succeeds. The chart publishes in parallel
with images and can remain available if an image build fails; the final workflow
notification waits for all artifacts to be ready.

```bash
kubectl create namespace agentconnect
kubectl -n agentconnect create secret generic agentconnect-secrets \
  --from-literal=DATABASE_URL='postgresql://USER:PASS@HOST:5432/agentconnect?schema=public' \
  --from-literal=API_KEY_PEPPER="$(openssl rand -hex 32)" \
  --from-literal=RELAY_TOKEN="$(openssl rand -hex 24)"

# The daemon pool's data-plane document (see values.yaml, daemonPool.dataPlane):
kubectl -n agentconnect create secret generic agentconnect-data-plane \
  --from-file=config.json=./data-plane.json

# --version: any released AgentConnect version, e.g. 1.2.3
helm install agentconnect oci://ghcr.io/agentconnect-md/charts/agentconnect \
  --version 1.2.3 --namespace agentconnect \
  --set publicUrl=https://app.example.test
```

Every value is documented inline in [values.yaml](values.yaml) — it is the reference.
The chart holds no secret values: it references namespace Secrets by name. Configure
install-wide model API keys through a Secret, or add organization keys later in the console.

The pool uses `runtime-sandbox` by default, with Claude Code, Codex, DeepSeek Harness,
and OpenCode. To run additional ACP runtimes such as Qwen Code, set
`daemonPool.runtime.repository` to
`ghcr.io/agentconnect-md/runtime-sandbox-full`. The chart keeps the selected
release tag; `daemonPool.runtime.image` remains available for an exact image pin.
OpenCode reuses the Anthropic, OpenAI, and DeepSeek pairs from
`daemonPool.modelCredentials` or `modelEgress.clients`, so existing provider configuration
needs no separate OpenCode mapping. For Qwen Code, other providers, or additional settings,
map the runtime's environment variables from a Secret with
`daemonPool.runtimeEnvironment.runtimes`. The mapping reaches both
the pool's model probe and agent sessions. See the
[Kubernetes runtime authentication guide](https://www.agentconnect.md/docs/self-hosting/kubernetes/runtime-authentication).

A slimmer install turns the extras off explicitly — for example, no agent execution in
this cluster and no public ingress:

```bash
# --skip-crds: installCRD=false suppresses only the controller templates; the
# CRDs in crds/ install on first install unless the CLI opts out.
helm install agentconnect oci://ghcr.io/agentconnect-md/charts/agentconnect \
  --version 1.2.3 --namespace agentconnect --skip-crds \
  --set daemonPool.enabled=false --set installCRD=false --set relay.enabled=false
```

## Requirements

- **Kubernetes >= 1.28** (the relay reads the `apps.kubernetes.io/pod-index` label).
- **PostgreSQL** you operate, reachable as `DATABASE_URL`. Migrations run once per
  install and upgrade in a pre-install/pre-upgrade hook Job, before any new Control Plane
  pod starts (`migrate.enabled`). Helm waits for that Job, so give a release with a long
  migration a longer `--timeout`.
- **Cluster-scoped install rights** by default: the daemon pool renders the TokenReview
  ClusterRole/Bindings, the agent-sandbox CRDs ship in the chart's `crds/` directory
  (applied on first install, skipped when present, never upgraded or deleted by Helm —
  `--skip-crds` opts out), and the vendored controller stack installs with the release
  (`installCRD`). `daemonPool.enabled=false` with `--skip-crds` needs none of it. On a
  cluster shared by several releases, no single release may own the cluster-shared stack:
  install every release with `--skip-crds` and `installCRD=false`, and apply the stack
  once out-of-band (`kubectl apply --server-side -f crds/agent-sandbox.yaml`, then
  `helm template --set installCRD=true --show-only templates/agent-sandbox.yaml`).
- **Gateway API** for public routing: the chart renders HTTPRoutes attached to a Gateway
  you already run (`route.gateway`), with TLS terminated at your edge. Set
  `route.enabled=false` to manage routing yourself; with `publicUrl` empty the chart
  renders no route at all.

## After installing

The Setup Server is deliberately unrouted — bootstrap sign-in, provider apps, and
deployment secrets over a port-forward:

```bash
kubectl -n agentconnect port-forward deployment/agentconnect-setup-server 8091:8091
```

The full self-hosting walkthrough (authentication, public URLs, provider apps, image
pinning) is the [AgentConnect OSS guide](https://www.agentconnect.md/docs/self-hosting).

## Source Cache

The Source Cache lets a new sandbox pod start its Git clone from a bundle in an
S3-compatible bucket rather than fetching the whole repository from its origin
([design](../../docs/designs/source-cache.md)). The bucket settings reach the daemon-pool
members only, never the runtime SandboxTemplate or the orphan reconciler. Sandbox pods
only ever receive short-lived presigned URLs, each for one object and one verb.

The chart turns the Source Cache on with a bundled store once `sourceCache.store.host` is
set. To use an external bucket instead, set `sourceCache.enabled: true` and the bucket
values described under [External bucket](#external-bucket). An external bucket takes
precedence over the bundled store.

### Bundled store

`sourceCache.store` (on by default) runs one [RustFS](https://rustfs.com) pod, an
S3-compatible store, on a PersistentVolumeClaim. It uses the upstream `rustfs/rustfs`
image. Presigned URLs must be `https://`, so the store is reached through the Gateway on its
own host. `publicUrl` is required, because the store admits only that origin for browser
CORS:

```yaml
publicUrl: https://console.example.test
sourceCache:
  store:
    host: objects.example.test
```

Provision that host's DNS, edge TLS and Gateway listener the same way as `apiHost`. Pool
members, the Control Plane, sandbox pods and browsers all use `https://<host>`. The edge
must pass request bodies up to `limits.maxBundleBytes` and must keep the `Host` header,
because every signature covers it.

The chart generates the store's key pair in the Secret `<release>-source-cache-store` and
reuses it on upgrade. RustFS starts with it, and members and the Control Plane mount it as
their bucket credentials. RustFS offers no simple way to create a narrower user, so these
are the store's root keys. The store holds nothing but this release's cache and transfers.

A post-install and post-upgrade Job runs
[`files/object-store-setup.sh`](files/object-store-setup.sh). It creates the bucket, applies
the [lifecycle rules](#bucket-lifecycle-rules), and sets the browser CORS rule. It is safe
to run repeatedly. Members check the lifecycle rules at start. A member that started before the Job's first
run writes no bundles until its next check, up to 6 hours later. Restart the pool after the
first install to start writing at once.

### External bucket

The bucket values below apply when `sourceCache.enabled` is true.

The endpoint must be `https://`, because the sandbox shim admits only an https bundle URL.
Leave `endpoint` empty to use AWS's regional S3 endpoint.

Credentials come from one of two sources:

- **Web identity (`credentials.source: serviceAccount`).** With
  `credentials.serviceAccount.roleArn` set, the chart projects a ServiceAccount token with
  the `sts.amazonaws.com` audience onto the member container alone. The member exchanges it
  through STS `AssumeRoleWithWebIdentity`. The role's trust policy names the subject
  `system:serviceaccount:<namespace>:ac-cloud-daemon`. On EKS, set
  `credentials.serviceAccount.roleArn`; this projected-token form is the supported
  configuration. An empty `roleArn` falls back to `AWS_ROLE_ARN` and
  `AWS_WEB_IDENTITY_TOKEN_FILE` in the member's environment, which exists only for
  setups where a pod-identity webhook injects them out of band. The chart exposes no
  annotation for the member ServiceAccount, and the orphan reconciler shares that
  ServiceAccount, so annotating it by hand gives the reconciler the role as well. A
  member started without either value refuses to boot.

  ```yaml
  sourceCache:
    enabled: true
    region: us-east-1
    bucket: example-agentconnect-source-cache
    credentials:
      source: serviceAccount
      serviceAccount:
        roleArn: arn:aws:iam::123456789012:role/agentconnect-source-cache
  ```

- **Static keys (`credentials.source: secret`).** The chart mounts an existing Secret into
  the member as read-only files, never as environment variables:

  ```bash
  kubectl -n agentconnect create secret generic agentconnect-source-cache \
    --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=...
  ```

  ```yaml
  sourceCache:
    enabled: true
    endpoint: https://minio.example.test
    region: us-east-1
    bucket: agentconnect-source-cache
    forcePathStyle: true
    credentials:
      source: secret
      secret:
        name: agentconnect-source-cache
  ```

Set `forcePathStyle: true` for MinIO, RustFS and most self-hosted stores. A dotted bucket
name or an IP-address endpoint uses path-style addressing anyway. AWS S3 has not yet been
verified against this signer (design §14).

| Value                        | Default | Meaning                                                   |
| ---------------------------- | ------- | --------------------------------------------------------- |
| `limits.maxBundleBytes`      | `2Gi`   | Largest bundle a pod may upload (at most `5Gi`)           |
| `limits.orgQuotaBytes`       | `20Gi`  | Committed plus reserved bytes per organization            |
| `limits.pendingReservation`  | `1h`    | How long an upload reservation lives; at least PUT + `5m` |
| `limits.unreadPointerDays`   | `30`    | Days before an unread pointer is swept                    |
| `limits.getUrlLifetime`      | `5m`    | Presigned GET lifetime (`1m` to `1h`)                     |
| `limits.putUrlLifetime`      | `15m`   | Presigned PUT lifetime (`1m` to `1h`)                     |
| `limits.transferMaxBytes`    | `512Mi` | Largest console file transfer (at most `5Gi`)             |
| `limits.transferUrlLifetime` | `30m`   | Transfer download link lifetime (`1m` to `12h`)           |

### Bucket lifecycle rules

Every member sweeps the cache: it deletes abandoned uploads, retags bundles no
pointer names `ac-cache=unreferenced`, and drops pointers unread for
`limits.unreadPointerDays`. The bucket must then expire the tagged objects. The bundled
store's setup Job writes these rules into its own bucket. For an external bucket, neither
the chart nor the daemon writes them, because `PutBucketLifecycleConfiguration` replaces
the bucket's whole configuration; apply them once yourself. Scope them to
`<prefix>/src/` and never to `snapshots/`. For the prefix `agentconnect`, save this as
`source-cache-lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "ac-source-cache-pending",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "agentconnect/src/", "Tags": [{ "Key": "ac-cache", "Value": "pending" }] } },
      "Expiration": { "Days": 2 }
    },
    {
      "ID": "ac-source-cache-unreferenced",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "agentconnect/src/", "Tags": [{ "Key": "ac-cache", "Value": "unreferenced" }] } },
      "Expiration": { "Days": 7 }
    }
  ]
}
```

With no prefix, use `src/`. The member logs this document for its own prefix when the
rules are missing. On AWS, read the current configuration first and add these two rules
to its `Rules`, because the put replaces every existing rule:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket example-agentconnect-source-cache
aws s3api put-bucket-lifecycle-configuration --bucket example-agentconnect-source-cache \
  --lifecycle-configuration file://source-cache-lifecycle.json
```

On MinIO, `mc ilm rule add` appends a rule without replacing the others:

```bash
mc ilm rule add --prefix agentconnect/src/ --tags 'ac-cache=pending' --expire-days 2 store/agentconnect-source-cache
mc ilm rule add --prefix agentconnect/src/ --tags 'ac-cache=unreferenced' --expire-days 7 store/agentconnect-source-cache
```

The member's credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
`s3:PutObjectTagging` on `<prefix>/src/*`, and
`s3:GetLifecycleConfiguration` on the bucket. Each member checks the rules at start and
every 6 hours. When the bucket has no enabled rule for either tag, it logs a warning
with the document above and stops writing bundles, while reads keep working. It resumes
on the first check that finds both. A member that cannot read the configuration warns
and keeps writing.

### Console file transfer

With a Source Cache configured, the Control Plane also signs console file transfers
([design](../../docs/designs/source-cache-file-transfer.md)), for every daemon: pool
members, and self-hosted or local daemons that hold no bucket credentials of their own.

- **Uploads:** a non-image file a user attaches in webchat is uploaded by the browser
  straight into the bucket, and the agent gets a presigned link to download it into its
  workspace.
- **Downloads:** a large text or binary workspace file is uploaded by its daemon (or its
  pod) on a URL the Control Plane signs, and the browser downloads it from the bucket.

The chart renders the bucket document as `AC_FILE_TRANSFER` on the Control Plane, and
mounts the same credentials there: the Secret, or the projected web identity token. With
a web identity, the role must also trust the Control Plane's ServiceAccount. Its policy
needs:

- `s3:PutObject`, `s3:PutObjectTagging` and `s3:GetObject` under
  `<prefix>/src/*/transfer/`;
- `s3:GetLifecycleConfiguration` on the bucket.

Transfer objects are tagged `ac-cache=pending`, so the 2-day `pending` lifecycle rule
above collects them. The Control Plane refuses transfers while that rule is missing.

Browsers and daemons outside the cluster reach the bucket directly, so two extra settings
apply:

- `sourceCache.publicEndpoint`: the `https://` origin browsers and out-of-cluster daemons
  use, when it differs from the in-cluster `endpoint`. Pool members and their pods keep
  using `endpoint`. Empty means `endpoint`.
- A bucket CORS rule admitting the console origin. Browsers send the signed checksum and
  tagging headers on upload and read nothing but the body on download:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://console.example.test"],
      "AllowedMethods": ["GET", "PUT"],
      "AllowedHeaders": ["x-amz-checksum-sha256", "x-amz-tagging", "content-type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket example-agentconnect-source-cache --cors-configuration file://source-cache-cors.json
```

A presigned link dies with the credentials that signed it, so a web-identity session must
outlive the longest URL its holder signs plus 6 minutes. By default the Control Plane and
each member derive that length: the larger of 1 hour and that sum. A
`transferUrlLifetime` over 54 minutes therefore makes the Control Plane ask STS for more
than an hour, and the role's `MaxSessionDuration` must allow it. Set
`sourceCache.credentials.serviceAccount.sessionDurationSeconds` to pin the length
instead.

### Computer screenshots

With a Source Cache configured, `computerScreenshots.enabled=true` stores the screenshots
agents take on Computers in the same bucket
([design](../../docs/designs/computer-use.md#9-screenshot-storage-implemented)). The chart
renders `AC_COMPUTER_SCREENSHOTS` on the Control Plane with the bucket's location and
credentials. The desktop daemon uploads each screenshot on a URL the Control Plane signs,
and the console reads it on another; the Control Plane never holds the bytes.

| Value              | Default | Meaning                                                 |
| ------------------ | ------- | ------------------------------------------------------- |
| `retentionDays`    | `30`    | Days kept for a Computer whose policy sets no retention |
| `maxRetentionDays` | `365`   | The most a Computer's policy may ask for                |
| `maxBytes`         | `8Mi`   | Largest screenshot stored (at most `32Mi`)              |

### Computer viewer STUN and TURN

The console's embedded Computer viewer sends media straight between the browser and the
desktop when it can: on the same network directly, and across NATs by hole punching through
the relays' STUN. When neither connects it uses TURN: the relays' own, or an external coturn
([design](../../docs/designs/computer-use.md#72-media-and-network)).

With `relay.stun.enabled`, each relay pod answers STUN Binding requests on UDP
`relay.stun.port` behind its own `<release>-relay-<ordinal>-stun` Service and registers
`stun:<relay.stun.host>:<port>` with the Control Plane, which hands it to both peers of a
viewing the Computer's policy allows to go peer to peer. The Service uses
`externalTrafficPolicy: Local` so the relay sees each client's own address; point the DNS name
for each ordinal at its Service. STUN is stateless and carries no media.

| Value                            | Default        | Meaning                                                             |
| -------------------------------- | -------------- | ------------------------------------------------------------------- |
| `relay.stun.enabled`             | `false`        | Answer STUN on each relay pod                                       |
| `relay.stun.port`                | `3478`         | UDP port the relay listens on                                       |
| `relay.stun.host`                | `''`           | Public host per pod; `{ordinal}` becomes the pod ordinal (required) |
| `relay.stun.publicPort`          | `''`           | Public port, when the load balancer listens on another one          |
| `relay.stun.service.type`        | `LoadBalancer` | Type of each pod's STUN Service                                     |
| `relay.stun.service.annotations` | `{}`           | Annotations for those Services (load balancer settings)             |

With `relay.turn.enabled`, each relay pod is a TURN server too, behind its own
`<release>-relay-<ordinal>-turn` Service: UDP and TCP on `relay.turn.publicPort`, and TLS on
443 when `relay.turn.tls.secretName` names a certificate covering every pod's host, for
networks that only let 443 out. The relay registers its `turn:` / `turns:` URLs with the
Control Plane, which hands both peers of a viewing short-lived credentials for them; the
Control Plane gives the relay the secret it checks them with over its authenticated link, so
there is no secret to configure. Both peers are relay-only, so a relay forwards only between
its own allocations: relayed addresses are virtual and no UDP port range is exposed. Each
allocation is capped in bandwidth and idles out, and the relay exports
`agentconnect.relay.turn.relayed_bytes` per Computer. The Service carries UDP and TCP
together, which needs mixed-protocol `LoadBalancer` support (Kubernetes 1.26 and most clouds);
point the DNS name for each ordinal at its Service. Managed computers, whose pods have no UDP a
browser can reach, start their viewer at TURN.

| Value                                      | Default        | Meaning                                                             |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| `relay.turn.enabled`                       | `false`        | Serve TURN on each relay pod                                        |
| `relay.turn.port`                          | `3480`         | Container port for UDP and TCP                                      |
| `relay.turn.host`                          | `''`           | Public host per pod; `{ordinal}` becomes the pod ordinal (required) |
| `relay.turn.publicPort`                    | `3478`         | Public UDP and TCP port                                             |
| `relay.turn.tls.secretName`                | `''`           | `kubernetes.io/tls` Secret for TURN over TLS; empty serves no TLS   |
| `relay.turn.tls.port` / `tls.publicPort`   | `5349` / `443` | Container and public port for TURN over TLS                         |
| `relay.turn.maxAllocations`                | `400`          | Allocations one pod holds; a viewing takes up to four               |
| `relay.turn.maxAllocationsPerCredential`   | `16`           | Allocations one viewer or desktop holds, across its credentials     |
| `relay.turn.maxBitsPerSecond`              | `10000000`     | What one allocation may send to its peer; the excess is dropped     |
| `relay.turn.idleTimeoutSeconds`            | `120`          | An allocation that relays nothing for this long is deleted          |
| `relay.turn.service.type` / `.annotations` | `LoadBalancer` | Each pod's TURN Service and its load balancer settings              |

Alternatively, run an external TURN server such as
[coturn](https://github.com/coturn/coturn) (BSD) with `use-auth-secret`, put its
`static-auth-secret` in `secrets.existingSecret`, and list its URLs; it takes precedence over
the relays' own. The Control Plane mints short-lived credentials per viewer and never sends
the secret out. Without TURN, a viewer with no direct path falls back to screenshots through
the relay.

| Value                            | Default                | Meaning                                                     |
| -------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `computerViewer.turn.urls`       | `[]`                   | `turn:`/`turns:` URLs, such as `turn:turn.example.com:3478` |
| `computerViewer.turn.secretKey`  | `COMPUTER_TURN_SECRET` | Key in `secrets.existingSecret` with coturn's secret        |
| `computerViewer.turn.ttlSeconds` | `21600`                | Lifetime of minted credentials; bounds one viewing          |

A Computer's policy can set `screenshotRetentionDays`; 0 means its screenshots are never
written. The Control Plane deletes expired screenshots itself, so the bucket needs no
extra lifecycle rule. Its credentials need `s3:PutObject`, `s3:GetObject` and
`s3:DeleteObject` under `<prefix>/computer-screenshots/`. Desktops and browsers reach the
bucket at `sourceCache.publicEndpoint` (or `endpoint`); a desktop's PUT is not a browser
request, and the console shows a screenshot with a plain `<img>`, so no CORS rule is
needed for either.

### Managed computers

`computerPool.enabled` (off by default) lets the daemon pool run Linux desktops as managed
Computers ([design](../../docs/designs/computer-use.md#151-positioning)): the chart renders a
desktop `SandboxTemplate` from the desktop image, its warm pool, and a NetworkPolicy that admits
only pool members to a desktop's bootstrap port, and turns the pool on in the members and the
Control Plane. Desktops register at the public Control Plane URL, so `apiHost` or `publicUrl`
is required.

| Value                               | Default              | Meaning                                                       |
| ----------------------------------- | -------------------- | ------------------------------------------------------------- |
| `computerPool.warmReplicas`         | `1`                  | Prewarmed desktops, so an `ephemeral` computer starts at once |
| `computerPool.home.size`            | `5Gi`                | A desktop's home volume, kept while it sleeps                 |
| `computerPool.home.storageClass`    | `standard`           | Storage class of the home volume                              |
| `computerPool.resources`            | 500m, 1Gi / 3Gi      | One desktop's requests and memory limit                       |
| `computerPool.ephemeralIdleSeconds` | `600`                | Idle time before an `ephemeral` desktop is deleted            |
| `computerPool.sleepIdleSeconds`     | `1800`               | Idle time before a `per-agent` or `manual` desktop sleeps     |
| `computerPool.image` / `repository` | `<registry>/desktop` | The desktop image, tagged like the release by default         |

## Node maintenance

The Control Plane runs as one replica, and it also serves the API. Evicting its pod, as a
node drain does, leaves the API unavailable until the replacement is ready — several
seconds. A rolling update has no such gap: its replacement is ready, and has had
`controlPlane.minReadySeconds` for the Gateway to find it, before the old pod stops.

Set `controlPlane.podDisruptionBudget=true` so a drain cannot evict the Control Plane pod,
and move the pod with a rolling update before draining its node:

```bash
kubectl cordon <node>
kubectl -n agentconnect rollout restart deployment/agentconnect-control-plane
kubectl -n agentconnect rollout status deployment/agentconnect-control-plane
kubectl drain <node> --ignore-daemonsets
```

Cordoning first makes the replacement start on another node, and waiting for the rollout to
finish keeps the old pod serving through that settling window. If a drain is already waiting
on the Control Plane pod, stop it before the restart: the budget counts the replacement as
available as soon as it is Ready, so a waiting drain would evict the old pod before the
window ends. Leave the budget off where nobody can act on a drain that is waiting.
