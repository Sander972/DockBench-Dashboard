import type { TelegramStatus } from '../types'

export interface BotRow { key: 'run' | 'owner' | 'group' | 'topics'; ok: boolean; text: string }

// getUpdates long-polls for 30 s, so a successful poll is never older than about that while the bot works
const STALE_MS = 90_000

// The setup checklist on the Telegram page, top to bottom; each row is green once /status says that step is done
export function botRows(t: TelegramStatus, now: number): BotRow[] {
  const s = t.status
  const fresh = !!s?.last_poll_at && now - Date.parse(s.last_poll_at) < STALE_MS
  const run = t.state !== 'running' ? `The container is ${t.state}.`
    : t.statusError === 'starting' ? 'Starting, waiting for /status.'
    : !s ? '/status does not answer. Check the container log in Portainer.'
    : !fresh ? 'Not reaching Telegram: the token was revoked or Telegram is unreachable. Check the container log in Portainer.'
    : `Running as @${s.bot}.`
  const n = s?.topics.length ?? 0
  return [
    { key: 'run', ok: t.state === 'running' && !!s && fresh, text: run },
    { key: 'owner', ok: !!s?.owner, text: s?.owner ? 'You own the bot. It ignores everyone else.' : 'Claim the bot, so it listens to you only.' },
    { key: 'group', ok: !!s?.group, text: s?.group ? 'It works in your forum group.' : 'Add it to a group with Topics on.' },
    { key: 'topics', ok: n > 0, text: n ? `${n} topic${n > 1 ? 's' : ''} bound.` : 'No topic yet: the bot opens one per running dev container within 30 seconds.' },
  ]
}

export const groupLink = (bot: string) => `https://t.me/${bot}?startgroup=setup&admin=manage_topics+pin_messages+delete_messages`
