import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Next 16 defaults to Turbopack; in this pnpm monorepo it would otherwise infer
// the workspace root ambiguously (multiple lockfiles), so pin it to the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Build fingerprint surfaced (as a hidden, select-to-reveal line) on the profile
// page — package version + git sha + build time. Unlike the per-tenant runtime
// config in lib/public-env.tsx, this is intrinsic to the image, so it's baked at
// build time. In CI/Docker the sha is passed in as GIT_SHA (the image is tagged by
// it, and .dockerignore drops .git); locally we read the working tree directly.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

function localGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const ciSha = process.env.GIT_SHA || process.env.GITHUB_SHA || ''
const sha = ciSha ? ciSha.slice(0, 7) : localGitSha()
const releaseVersion = process.env.APP_VERSION || `v${pkg.version}`
const appVersion = sha ? `${releaseVersion}+${sha}` : releaseVersion
const buildTime = process.env.BUILD_TIME || `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BUILD_TIME: buildTime
  }
}

export default nextConfig
