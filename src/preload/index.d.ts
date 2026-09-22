import type { PlexoApi } from './index'

declare global {
  interface Window {
    plexo: PlexoApi
  }
}
