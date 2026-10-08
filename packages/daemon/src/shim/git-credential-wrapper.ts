/**
 * The `bin/git-credential` a daemon installation ships beside its `shim/` bundle.
 *
 * The host and srt strategies use the installation's `dist` as a session's helper root, and `shimPaths` names
 * `<helperRoot>/bin/git-credential` there as it names `/opt/agentconnect/bin/git-credential` in the image. It finds
 * the helper bundle relative to itself, so the build machine's paths are never baked in.
 */
export const INSTALLATION_GIT_CREDENTIAL_WRAPPER =
  '#!/bin/sh\n# agentconnect git credential helper — see src/shim/git-credential.ts.\nexec node "$(dirname "$0")/../shim/git-credential.js" "$@"\n'
