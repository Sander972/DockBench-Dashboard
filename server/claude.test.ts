import { expect, test } from 'bun:test'
import { lastLine, loginCodeCmd, loginUrl } from './claude'

// as Claude Code 2.1.300 prints it without a TTY
const started = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=abc\nPaste code here if prompted > "

test('loginUrl takes the link from the visit line, null without one', () => {
  expect(loginUrl(started)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=abc')
  expect(loginUrl('Opening browser to sign in…\n')).toBeNull()
  expect(loginUrl('visit: http://evil.example/x')).toBeNull()
})

test('lastLine is the last non-empty line, without the prompt it lands on', () => {
  expect(lastLine('Paste code here if prompted > Login failed: Request failed with status code 400\n\n')).toBe('Login failed: Request failed with status code 400')
  expect(lastLine(started)).toBe("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize") // the query (OAuth state) never reaches the log
  expect(lastLine('')).toBe('')
})

test('the code goes in as an argument, not inside the shell string', () => {
  const cmd = loginCodeCmd('$(rm -rf ~)')
  expect(cmd.at(-1)).toBe('$(rm -rf ~)')
  expect(cmd[2]).not.toContain('rm -rf ~')
})
