import { useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { PLATFORMS, platformOffered, type PlatformTile } from './platforms/host-projections'
import { platformRegistry } from './platforms/registry'

// One column width for every group: the fullest row fills, shorter rows keep that width left-aligned.
export const PLATFORM_TILE_WIDTH = 'w-[calc((100%_-_(var(--tile-cols)_-_1)_*_--spacing(2))_/_var(--tile-cols))]'

export function IntegrationPlatformGroups({
  renderTile,
  className,
  selectedPlatform
}: {
  renderTile: (tile: PlatformTile) => ReactNode
  className?: string
  selectedPlatform?: string
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
  const [expanded, setExpanded] = useState(false)
  const overflow = groups.find((entry) => entry.group === 'chat')!.tiles.slice(6)
  if (!expanded && overflow.some((tile) => tile.key === selectedPlatform)) setExpanded(true)
  const cols = Math.min(7, Math.max(...groups.map((entry) => entry.tiles.length)))

  return (
    <div className={`flex flex-col gap-5 ${className ?? ''}`} style={{ '--tile-cols': cols } as CSSProperties}>
      {groups.map(({ group, tiles: groupTiles }) => {
        const collapsed = group === 'chat' && groupTiles.length > 7 && !expanded
        return (
          <section key={group} aria-label={t(group)} className="min-w-0">
            <h3 className="fldlbl mb-2">{t(group)}</h3>
            <div className="flex flex-wrap gap-2">
              {(collapsed ? groupTiles.slice(0, 6) : groupTiles).map(renderTile)}
              {collapsed && (
                <button
                  type="button"
                  className={`ptile ${PLATFORM_TILE_WIDTH} flex-none justify-center px-0 font-sans text-[11px] font-semibold leading-normal hover:border-(--border-strong) hover:bg-(--surface-hover) desktop:text-[12px]`}
                  onClick={() => setExpanded(true)}
                >
                  {t('more')}
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
