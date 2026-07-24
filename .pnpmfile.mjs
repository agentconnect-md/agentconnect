/**
 * Keep Prisma's build-time CLI peers out of production deployments.
 *
 * Prisma Client 7 declares `prisma` and `typescript` as optional peers. pnpm
 * resolves optional peers into the lockfile snapshot, so a production deploy
 * otherwise pulls the CLI, engines, Studio, PGlite, and TypeScript back in even
 * though the control-plane server never imports them. The full builder still
 * installs both packages directly from devDependencies for `prisma generate`.
 */
function readPackage(pkg) {
  if (pkg.name === '@prisma/client' && pkg.version?.startsWith('7.')) {
    delete pkg.peerDependencies?.prisma
    delete pkg.peerDependencies?.typescript
    delete pkg.peerDependenciesMeta?.prisma
    delete pkg.peerDependenciesMeta?.typescript
  }
  return pkg
}

export const hooks = { readPackage }
