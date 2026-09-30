'use client'

// Which product the deployment's Gitea-API instance is (gitea-integration.md §3), so every Gitea mark draws the right one.
import { createContext, useContext } from 'react'
import type { GiteaConnectionDto } from './api'

export type GiteaProduct = GiteaConnectionDto['instanceProduct']

/** Gitea outside the console's data provider and until a connection has reported a version. */
export const GiteaProductContext = createContext<GiteaProduct>('gitea')

export function useGiteaProduct(): GiteaProduct {
  return useContext(GiteaProductContext)
}

/** The product the organization's connection last observed; Gitea when none has. */
export function giteaProductOf(
  connections: readonly Pick<GiteaConnectionDto, 'instanceProduct' | 'instanceVersion'>[]
): GiteaProduct {
  return connections.find((c) => c.instanceVersion !== null)?.instanceProduct ?? 'gitea'
}
