import { describe, expect, it } from 'vitest'
import type { TelegramStatus } from '../types'
import { botRows, groupLink } from './telegram'

const NOW = Date.parse('2026-10-14T10:00:00Z')
const t = (o: Partial<TelegramStatus> = {}, s: Partial<NonNullable<TelegramStatus['status']>> = {}): TelegramStatus => ({
  deployed: true, state: 'running', startedAt: '2026-10-14T09:00:00Z', image: 'x', imageUpdate: false, statusError: null, now: '2026-10-14T10:00:00Z',
  status: { bot: 'mybot', owner: true, group: true, topics: [{ name: 'shop', running: true, queued: 1 }], last_poll_at: '2026-10-14T09:59:50Z', uptime_seconds: 3600, ...s },
  ...o,
})
const ok = (x: TelegramStatus) => botRows(x, NOW).map(r => r.ok)

describe('botRows', () => {
  it('is all green for a set-up bot', () => expect(ok(t())).toEqual([true, true, true, true]))
  it('flags a stale poll as not reaching Telegram', () => {
    const r = botRows(t({}, { last_poll_at: '2026-10-14T09:58:00Z' }), NOW)[0]
    expect(r.ok).toBe(false)
    expect(r.bad).toBe(true)
    expect(r.text).toContain('Not reaching Telegram')
  })
  it('says status unavailable instead of the revoked verdict while GET /api/telegram fails', () => {
    const r = botRows(t({}, { last_poll_at: '2026-10-14T09:58:00Z' }), NOW, 'Failed to fetch')[0]
    expect(r.ok).toBe(false)
    expect(r.bad).toBe(false)
    expect(r.text).toBe('Status unavailable: Failed to fetch')
  })
  it('judges freshness by the server clock, not a skewed browser clock', () => {
    const skewed = NOW + 5 * 60_000 // browser 5 minutes ahead
    expect(botRows(t(), skewed)[0].ok).toBe(true)
    expect(botRows(t({ now: '2026-10-14T10:05:00Z' }, { last_poll_at: '2026-10-14T10:04:50Z' }), NOW - 5 * 60_000)[0].ok).toBe(true)
    expect(botRows(t({ now: '2026-10-14T10:05:00Z' }), NOW)[0].ok).toBe(false)
  })
  it('says why when the container is not running or /status is silent', () => {
    expect(botRows(t({ state: 'exited', status: null }), NOW)[0].text).toBe('The container is exited.')
    expect(botRows(t({ status: null, statusError: 'starting' }), NOW)[0].text).toBe('Starting, waiting for /status.')
    expect(botRows(t({ status: null, statusError: 'dead' }), NOW)[0].text).toBe('/status does not answer. Check the container log in Portainer.')
  })
  it('walks owner, group and topics in order', () => {
    expect(ok(t({}, { owner: false, group: false, topics: [] }))).toEqual([true, false, false, false])
    expect(ok(t({ status: null, statusError: 'dead' }))).toEqual([false, false, false, false])
  })
  it('builds the add-to-group link with the Manage topics, Pin messages and Delete messages rights', () => expect(groupLink('mybot')).toBe('https://t.me/mybot?startgroup=setup&admin=manage_topics+pin_messages+delete_messages'))
})
