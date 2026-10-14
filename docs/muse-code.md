# Muse Code

AgentConnect offers **Muse Code** as runtime `muse-acp`, using the
[BrokkAi ACP adapter](https://github.com/BrokkAi/muse-acp). The adapter runs
Meta's Muse Code locally on the daemon or inside its runtime sandbox.

## Self-hosted daemon

1. Install [Muse Code](https://dev.meta.ai/docs/muse-code/overview) on the daemon
   machine and check that `muse --version` succeeds.
2. Install the adapter with `npm install -g @brokkai/muse-acp@0.13.0`. Use this
   scoped package; the unscoped `muse-acp` package is a different adapter.
3. Provide `META_API_KEY` in the daemon's environment, then restart the daemon.
   See [Muse authentication](https://dev.meta.ai/docs/muse-code/auth) for obtaining
   and configuring a key.
4. Select **Muse Code** when creating or editing an agent. No custom runtime
   definition is required.

Both `muse` and `muse-acp` must be executable by the daemon user. The daemon
includes Muse's default installation directory in discovery and resolves the
native executable before isolating an agent's HOME. A custom adapter definition
can set `MUSE_CLI` to an absolute path when Muse is installed elsewhere. The
curated launcher disables Muse's automatic updates during agent execution;
update the installation separately.

The adapter's published Linux binaries currently require glibc 2.39. On older
Linux distributions, build the same release locally with Rust 1.88 or newer:

```sh
cargo install --git https://github.com/BrokkAi/muse-acp --tag v0.13.0 --locked muse-acp
```

Make the resulting `muse-acp` executable available on the daemon's `PATH`.

## Runtime sandbox

The **full** runtime image includes Muse Code `1.4.7-R6101.1` and adapter `0.13.0`.
The adapter is compiled against the image's Bookworm libraries. Both downloads
are pinned and checked against SHA-256 hashes; the image build probes the actual
ACP executable before publishing its runtime inventory. The standard image does
not include Muse Code.

Provide `META_API_KEY` through the runtime's configured environment. The image
contains no provider credentials.

## Agent state and capabilities

Each agent keeps its own Muse configuration and session state. The daemon seeds
only `settings.json` from `$XDG_CONFIG_HOME/muse`, or `~/.config/muse` by default.
Host credentials, workspace trust, sessions, and memory are not copied. Use an
API key for unattended operation; the adapter also advertises Muse's terminal
login flow for an agent's own HOME. Importing a host browser login is unsupported.

The curated launcher passes `--trust-workspace` to Muse for the agent's assigned
workspace. This enables project rules and skills installed by AgentConnect's
bundled skills CLI using the `universal` identity. Model and reasoning selectors,
streaming replies, session restore, MCP tools, and approval requests use the
existing ACP paths. Muse uses AgentConnect's managed memory mode; native memory
and disabling memory are not advertised as verified capabilities.
