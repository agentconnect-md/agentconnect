# Config-file secrets: Docker & Kubernetes credentials

Some tools want a **config file**, not an env var — Docker reads
`$DOCKER_CONFIG/config.json`, Kubernetes tools read the file `$KUBECONFIG`
points at. AgentConnect bridges the two with a `*_DATA` secret convention:
put the **whole file content** in a write-only agent secret, and the daemon
turns it into a real file at agent start.

| Secret               | Materialized file                         | Env var injected      |
| -------------------- | ----------------------------------------- | --------------------- |
| `KUBECONFIG_DATA`    | `<agent dir>/run/config-files/kubeconfig` | `KUBECONFIG=<file>`   |
| `DOCKER_CONFIG_DATA` | `…/run/config-files/docker/config.json`   | `DOCKER_CONFIG=<dir>` |

At agent start the daemon writes each value to a private mode-0600 file under
the agent's own directory and sets the tool's standard env var to point at it;
the raw secret value is **removed from the agent's environment** — only the
pointer remains. Because `KUBECONFIG` and `DOCKER_CONFIG` are the
ecosystem-standard variables, everything that honors them works unchanged with
no per-tool setup: `docker` (plus Buildx/Compose), `kubectl`, `helm`,
`helmfile`, `kustomize`, and any client-go/SDK program the agent runs or
writes.

Because the secret is per agent, each agent can carry its own credentials —
different registries, different clusters, or different identities on the same
cluster.

## Docker registry authentication

Add a secret named `DOCKER_CONFIG_DATA` with the contents of a Docker
configuration file (`config.json`):

```json
{
  "auths": {
    "ghcr.io": {
      "auth": "<base64(username:token)>"
    }
  }
}
```

The `auth` value is Base64-encoded `username:token`; it is not encrypted. The
underlying credential must already have permission to access the target
registry and package. No login or setup command is needed in the session:

```bash
docker push ghcr.io/example/image:tag
```

The legacy secret name `DOCKER_AUTH_CONFIG` is still honored the same way;
prefer `DOCKER_CONFIG_DATA`. When both are set, the new name wins.

## Kubernetes authentication

Add a secret named `KUBECONFIG_DATA` with a full kubeconfig YAML as its value.

```bash
kubectl get pods -n my-namespace # just works
helm upgrade my-release ./chart  # same credentials
```

A single kubeconfig value can carry several clusters/contexts; the agent
switches with `--context` / `kubectl config use-context` as usual.

Pair each agent with a **dedicated ServiceAccount bound to least-privilege
RBAC** and put that ServiceAccount's credentials in its kubeconfig: the
permission difference between agents is then enforced by the cluster, and the
cluster's audit log attributes each action to the agent's own identity.

## Behavior details

- The files exist only while the agent is actually working: they are written
  before each turn is dispatched and **removed about a minute after the agent
  goes quiet** — no running turn and no in-flight background task
  (`limits.configFilesIdleMs`, default 60s). The next message transparently
  re-creates them before it reaches the agent, so a warm session never notices.
  They are also removed whenever the agent's process stops (idle reclaim, agent
  removal or reconfiguration, daemon shutdown), and leftovers of a non-graceful
  exit are swept at daemon startup — the secret's only resting place on disk is
  the agent's own configuration.
- The files are rewritten on every agent (re)start and removed when the secret
  is deleted. Editing a secret respawns the agent, so rotation takes effect on
  the next session.
- If the pointer var (`KUBECONFIG` / `DOCKER_CONFIG`) is also set explicitly on
  the agent, the explicit value wins: the secret is left as a plain env var and
  the daemon posts a warning into the session.
- Sandboxed agents (**Run in sandbox**) can read the files: they live under the
  agent's directory, which stays readable (and non-writable) inside the
  sandbox. This is also why the daemon avoids the system temp dir — the Linux
  sandbox mounts a fresh tmpfs over it, which would hide the files.
- Transcript masking extends into structured secret values (a docker `auth`,
  kubeconfig tokens and client key/cert data, whole-file echoes): values the
  agent emits render as `[secret:NAME]`.
- The materialized file is distribution and routing, **not a same-host security
  boundary** — the secret value also rests in the agent's `agent.json` on the
  daemon host, and agents on one daemon run as the same OS user. Agents that
  must not share a trust domain belong on separate daemon machines.

Keep these values in the agent's **Secrets** section rather than its plain
environment-variable section — secrets are masked out of transcripts and other
outbound surfaces. Do not print the files, include their contents in command
arguments, or commit them to a repository.
