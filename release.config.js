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
        writerOpts: { headerPartial: '' },
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
    // Keep the full compare link after the release notes.
    './scripts/semantic-release-full-changelog.js',
    // Pass the release tag to the parallel artifact jobs and write the release notes.
    './scripts/semantic-release-summary.js',
    [
      // Stable versions create GitHub Releases; prereleases only publish Git metadata.
      './scripts/semantic-release-github.js',
      {
        // The release summary and stable GitHub Release replace per-PR comments.
        successCommentCondition: false,
        labels: false
      }
    ]
  ]
}
