// The dashboard itself and the Telegram bot as images the dashboard can check and update, for the Updates panel in Settings. Kept free of env so tests drive it with fakes.
import { updateAvailable, type ImageCheck } from './containers'
import type { ContainerRow, Inspect } from './docker'

export const DASHBOARD_NAME = 'dockbench-dashboard'

// one id per server process: after a self-update the page waits for it to change, then reloads into the new build
export const BOOT_ID = crypto.randomUUID()

// SystemImage in src/types.ts
export interface SystemImage {
  name: string
  deployed: boolean
  state: string | null
  startedAt: string | null
  image: string | null
  imageUpdate: boolean | null
  imageCheckedAt: string | null
  // why the last pull failed, so the panel can say more than "not checked"
  checkError: string | null
}

export function imageRow(name: string, c: ContainerRow | null, x: Inspect | null, check: ImageCheck | null): SystemImage {
  if (!c || !x) return { name, deployed: false, state: null, startedAt: null, image: null, imageUpdate: null, imageCheckedAt: null, checkError: null }
  return {
    name,
    deployed: true,
    state: c.state,
    startedAt: x.startedAt,
    image: x.image,
    imageUpdate: updateAvailable(x.image, check?.imageId ?? null, x.imageId),
    imageCheckedAt: check ? new Date(check.at).toISOString() : null,
    checkError: check?.error ?? null,
  }
}
