import type { CSSProperties, ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { PLATFORMS, platformOffered, type PlatformTile } from './platforms/host-projections'
import { platformRegistry } from './platforms/registry'

// One column width for every group: the fullest row fills, shorter rows keep that width left-aligned.
export const PLATFORM_TILE_WIDTH = 'w-[calc((100%_-_(var(--tile-cols)_-_1)_*_--spacing(2))_/_var(--tile-cols))]'

export function IntegrationPlatformGroups({
  renderTile,
  className
}: {
  renderTile: (tile: PlatformTile) => ReactNode
  className?: string
}) {
  const t = useTranslations('Integrations.dialog')
  const tiles = PLATFORMS.filter((tile) => platformOffered(tile.key))
  const groups = (['chat', 'workflow'] as const).map((group) => ({
    group,
    tiles: tiles.filter((tile) => {
      const module = platformRegistry.get(tile.key)
      return (module ? (module.integrationGroup ?? 'chat') : 'workflow') === group
    })
  }))
  const cols = Math.max(...groups.map((entry) => entry.tiles.length))

  return (
    <div className={`flex flex-col gap-5 ${className ?? ''}`} style={{ '--tile-cols': cols } as CSSProperties}>
      {groups.map(({ group, tiles: groupTiles }) => (
        <section key={group} aria-label={t(group)} className="min-w-0">
          <h3 className="fldlbl mb-2">{t(group)}</h3>
          <div className="flex gap-2">{groupTiles.map(renderTile)}</div>
        </section>
      ))}
    </div>
  )
}
