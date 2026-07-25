export default {
  branches: ['release', { name: 'main', prerelease: 'rc' }],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: [
          { type: 'release', scope: 'major', release: 'major' },
          { type: 'release', scope: 'minor', release: 'minor' },
          { type: 'release', scope: 'patch', release: 'patch' },
          { type: 'chore', release: 'patch' },
          { type: 'refactor', release: 'patch' }
        ]
      }
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        presetConfig: {
          types: [
            { type: 'feat', section: 'Features' },
            { type: 'fix', section: 'Bug Fixes' },
            { type: 'chore', section: 'Internal', hidden: false },
            { type: 'refactor', section: 'Internal', hidden: false }
          ]
        }
      }
    ],
    [
      // Publish ONLY the daemon to npm, as the self-contained build bundle.
      // The CP/web ship as Docker images through build.yaml, not npm packages.
      // tsdown inlines every dependency into dist/, so the published manifest
      // is stripped to zero runtime deps before publish.
      // pnpm (not @semantic-release/npm → npm) because this is a pnpm workspace:
      // npm cannot resolve the `workspace:` protocol on the daemon's deps.
      '@semantic-release/exec',
      {
        // Order matters: bump → BUILD → strip deps. The build must run while
        // `dependencies` still lists @agentconnect.md/protocol, because the
        // daemon's build (`pnpm --filter '{.}^...' build && tsdown`) reads that
        // field to build its workspace deps' dist/ first — and tsdown inlines
        // protocol by resolving its built `import` export → ./dist/index.js.
        // If we strip deps BEFORE the build, `{.}^...` matches no projects,
        // protocol/dist is never built, and tsdown SILENTLY externalizes the
        // import (rolldown can't resolve a missing file) — shipping a bundle
        // that throws ERR_MODULE_NOT_FOUND. So: build first (deps intact, every
        // dependency inlined into dist/ — the daemon's only SQLite is built-in
        // node:sqlite), THEN strip to zero runtime deps. The post-build guard in
        // the daemon's build script fails loudly if any import is left external.
        prepareCmd: 'sh scripts/publish-daemon-if-changed.sh "${lastRelease.gitTag}" "${nextRelease.version}" prepare',
        // Publish is conditional (see the script): the daemon goes to npm only
        // when its bundle inputs changed since the previous release on this
        // channel — most releases don't touch the daemon, and skipping no-op
        // publishes keeps npm versions meaningful for the manually-upgrading
        // fleet. rc versions go to the `rc` tag, stable to `latest`, so
        // `npm i @agentconnect.md/daemon` never grabs an rc. The script restores
        // the manifest changed by prepareCmd before any later release step runs.
        publishCmd:
          'sh scripts/publish-daemon-if-changed.sh "${lastRelease.gitTag}" "${nextRelease.version.includes("-") ? "rc" : "latest"}"'
      }
    ],
    [
      // Publish the CLI (@agentconnect.md/cli) to npm the same way as the daemon:
      // a self-contained tsdown bundle stripped to zero runtime deps. Same
      // build-then-strip ordering (its build inlines protocol + connection), and
      // the same conditional skip — the CLI is the thin, stable bin and changes
      // far less often than the daemon, so most releases skip its publish. Its
      // change detector additionally tracks packages/connection (the login auth
      // probe depends on it). Runs as a separate exec instance after the daemon's.
      '@semantic-release/exec',
      {
        prepareCmd: 'sh scripts/publish-cli-if-changed.sh "${lastRelease.gitTag}" "${nextRelease.version}" prepare',
        publishCmd:
          'sh scripts/publish-cli-if-changed.sh "${lastRelease.gitTag}" "${nextRelease.version.includes("-") ? "rc" : "latest"}"'
      }
    ],
    // Expose the published tag to release.yaml so image publication can run
    // next in the same workflow, and add the version + notes to the job summary.
    // Write through Node's file API so commit-derived notes are never evaluated
    // by the shell.
    './scripts/semantic-release-summary.js',
    [
      // semantic-release creates and pushes the git tag before publish plugins
      // run. Keep that behavior for rc builds, but let this adapter skip the
      // extra GitHub Release entry for prereleases. Stable releases still use
      // @semantic-release/github unchanged.
      './scripts/semantic-release-github.js',
      {
        // Disable the per-PR "included in vX" comment (deprecated `successComment:
        // false` → `successCommentCondition: false`). The Release Summary above +
        // the stable GitHub Release page are the release record.
        successCommentCondition: false,
        labels: false
      }
    ]
  ]
}
