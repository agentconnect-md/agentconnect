import type { CSSProperties, ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { PLATFORMS, platformOffered, type PlatformTile } from './platforms/host-projections'
import { platformRegistry } from './platforms/registry'

export function IntegrationPlatformGroups({ renderTile }: { renderTile: (tile: PlatformTile) => ReactNode }) {
  const t = useTranslations('Integrations.dialog')
  const tiles = PLATFORMS.filter((tile) => platformOffered(tile.key))
  const groups = (['chat', 'workflow'] as const).map((group) => ({
    group,
    tiles: tiles.filter((tile) => {
      const module = platformRegistry.get(tile.key)
      return (module ? (module.integrationGroup ?? 'chat') : 'workflow') === group
    })
  }))
  // Tiles may size against --tile-cols so every group shares one column width.
  const cols = Math.max(...groups.map((entry) => entry.tiles.length))

  return (
    <div className="flex flex-col gap-5" style={{ '--tile-cols': cols } as CSSProperties}>
      {groups.map(({ group, tiles: groupTiles }) => (
        <section key={group} aria-label={t(group)} className="min-w-0">
          <h3 className="fldlbl mb-2">{t(group)}</h3>
          <div className="flex flex-wrap gap-2 desktop:flex-nowrap">{groupTiles.map(renderTile)}</div>
        </section>
      ))}
    </div>
  )
}
