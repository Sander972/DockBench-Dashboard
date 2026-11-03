import { expect, test } from 'bun:test'
import { device } from './http'

test('device names the OS and browser, and falls back to the raw User-Agent', () => {
  expect(device('Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome')
  expect(device('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
  expect(device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Windows · Edge')
  expect(device('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Mac · Firefox')
  expect(device('curl/8.9.1')).toBe('curl/8.9.1')
  expect(device(null)).toBe('unknown device')
})
