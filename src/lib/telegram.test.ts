import { describe, expect, it } from 'vitest'
import type { TelegramStatus } from '../types'
import { botRows, groupLink } from './telegram'

const NOW = Date.parse('2026-10-14T10:00:00Z')
const t = (o: Partial<TelegramStatus> = {}, s: Partial<NonNullable<TelegramStatus['status']>> = {}): TelegramStatus => ({
  deployed: true, state: 'running', startedAt: '2026-10-14T09:00:00Z', image: 'x', imageUpdate: false, statusError: null,
  status: { bot: 'mybot', owner: true, group: true, topics: [{ name: 'shop', running: true, queued: 1 }], last_poll_at: '2026-10-14T09:59:50Z', uptime_seconds: 3600, ...s },
  ...o,
})
const ok = (x: TelegramStatus) => botRows(x, NOW).map(r => r.ok)

describe('botRows', () => {
  it('is all green for a set-up bot', () => expect(ok(t())).toEqual([true, true, true, true]))
  it('flags a stale poll as not reaching Telegram', () => {
    const r = botRows(t({}, { last_poll_at: '2026-10-14T09:58:00Z' }), NOW)[0]
    expect(r.ok).toBe(false)
    expect(r.text).toContain('Not reaching Telegram')
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
