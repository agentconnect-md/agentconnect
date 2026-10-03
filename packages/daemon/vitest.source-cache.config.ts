import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// The `source-cache-minio` project: presigned URLs against a MinIO server binary ($AC_TEST_MINIO_BIN), kept apart from `vitest run`.
export default defineConfig({
  test: {
    name: 'source-cache-minio',
    environment: 'node',
    include: ['test/source-cache-minio.int.test.ts'],
    globalSetup: ['./test/tmpdir-global-setup.ts', './test/source-cache/minio-global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    reporters: githubActionsReporters('daemon-source-cache.md')
  }
})
