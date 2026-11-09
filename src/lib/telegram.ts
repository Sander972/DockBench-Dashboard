import type { TelegramStatus } from '../types'

// bad: the red LED (the bot container is not running, its /status is silent or it is not reaching Telegram); a row neither ok nor bad is a step to do or to wait for (starting, or no answer to judge by)
export interface BotRow { key: 'run' | 'owner' | 'group' | 'topics'; ok: boolean; bad?: boolean; text: string }

// getUpdates long-polls for 30 s, so a successful poll is never older than about that while the bot works
const STALE_MS = 90_000

// The setup checklist on the Telegram page, top to bottom; each row is green once /status says that step is done. now is the browser clock and askedAt the browser time the pending GET /api/telegram was sent (0 when none is pending): the bot's last poll is aged on the answer's server clock (the bot shares the server's host clock), so a skewed browser clock does not matter, moved on by the time the pending request has waited, so the age keeps growing while a request hangs (it never fails) but an answer from an earlier visit is judged as it was until the reload answers. error: GET /api/telegram is failing, or the pending one has waited STALE_MS, so t is the last answer and its age says nothing about the bot.
export function botRows(t: TelegramStatus, now: number, error = '', askedAt = 0): BotRow[] {
  const waited = askedAt ? Math.max(0, now - askedAt) : 0
  if (!error && waited > STALE_MS) error = 'no answer for over 90 seconds'
  const s = t.status
  const fresh = !!s?.last_poll_at && (Date.parse(t.now) || now - waited) + waited - Date.parse(s.last_poll_at) < STALE_MS
  const run = error ? `Status unavailable: ${error}`
    : t.state !== 'running' ? `The container is ${t.state}.`
    : t.statusError === 'starting' ? 'Starting, waiting for /status.'
    : !s ? '/status does not answer. Check the container log in Portainer.'
    : !fresh ? 'Not reaching Telegram: the token was revoked or Telegram is unreachable. Check the container log in Portainer.'
    : `Running as @${s.bot}.`
  const ok = !error && t.state === 'running' && !!s && fresh
  const wait = !!error || (t.state === 'running' && t.statusError === 'starting')
  const n = s?.topics.length ?? 0
  return [
    { key: 'run', ok, bad: !ok && !wait, text: run },
    { key: 'owner', ok: !!s?.owner, text: s?.owner ? 'You own the bot. It ignores everyone else.' : 'Claim the bot, so it listens to you only.' },
    { key: 'group', ok: !!s?.group, text: s?.group ? 'It works in your forum group.' : 'Add it to a group with Topics on.' },
    { key: 'topics', ok: n > 0, text: n ? `${n} topic${n > 1 ? 's' : ''} bound.` : 'No topic yet: the bot opens one per running dev container within 30 seconds.' },
  ]
}

export const groupLink = (bot: string) => `https://t.me/${bot}?startgroup=setup&admin=manage_topics+pin_messages+delete_messages`
