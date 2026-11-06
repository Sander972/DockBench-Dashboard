import { describe, expect, it } from 'vitest'
import { ago, contrastNote, dur, gib, gitMsg, gitParts, onAccent, repoLabel, repoUrl, short, useCls, when } from './format'
import { litCount, segments } from './meter'
import { deployErrors, slug, type DeployDraft } from './deploy'
import type { DevContainerStatus } from '../types'

describe('format', () => {
  it('dur ranges', () => {
    expect(dur(-5)).toBe('0s')
    expect(dur(59.9)).toBe('59s')
    expect(dur(60)).toBe('1m 0s')
    expect(dur(41 * 60 + 4)).toBe('41m 4s')
    expect(dur(3600)).toBe('1h 0m')
    expect(dur(19 * 3600 + 5 * 60)).toBe('19h 5m')
    expect(dur(86400 * 3 + 3600 * 4 + 59)).toBe('3d 4h')
    expect(ago(1000, 126000)).toBe('2m 5s ago')
  })
  it('repo URL forms', () => {
    expect(repoUrl('octocat/shop')).toBe('https://github.com/octocat/shop')
    expect(repoUrl('octocat/shop.git')).toBe('https://github.com/octocat/shop')
    expect(repoUrl('https://github.com/octocat/api-gateway.git')).toBe('https://github.com/octocat/api-gateway')
    expect(repoUrl('git@github.com:octocat/ml-pipeline.git')).toBe('https://github.com/octocat/ml-pipeline')
    expect(repoUrl(null)).toBe(null)
    expect(repoLabel('git@github.com:octocat/ml-pipeline.git')).toBe('octocat/ml-pipeline')
    expect(repoLabel('https://gitlab.com/x/y')).toBe('https://gitlab.com/x/y')
  })
  it('sizes', () => {
    expect(gib(3.444)).toBe('3.44')
    expect(gib(33.5)).toBe('33.5')
    expect(short(3.62)).toBe('3.6G')
    expect(short(33.5)).toBe('34G')
  })
  it('when', () => {
    const now = new Date(2026, 9, 13, 15, 0).getTime()
    expect(when(new Date(2026, 9, 13, 9, 5).getTime(), now)).toBe('09:05')
    expect(when(new Date(2026, 9, 12, 13, 2).getTime(), now)).toBe('Mon 13:02')
  })
  it('git line parts', () => {
    const st = (o: Partial<DevContainerStatus>) => ({ repo: null, tunnel_name: null, branch: 'main', dirty: 0, last_commit: null, ahead: 0, behind: 0, tunnel: 'connected', mise: {}, claude_logged_in: true, uptime_seconds: 0, ...o }) as DevContainerStatus
    const t = (o: Partial<DevContainerStatus>) => gitParts(st(o)).map(p => p.text).join(' · ')
    expect(t({})).toBe('main · clean · in sync')
    expect(t({ dirty: 3, ahead: 1, behind: 2 })).toBe('main · 3 changed · ↑1 ↓2')
    expect(gitParts(st({ ahead: 1, behind: 2 }))[2].num).toBe(true)
    expect(t({ ahead: null, behind: null })).toBe('main · clean · no upstream')
    expect(t({ branch: 'HEAD', dirty: 12, ahead: null, behind: null })).toBe('detached HEAD · 12 changed')
    expect(t({ dirty: null })).toBe('main · in sync')
    expect(gitParts(null)).toEqual([])
  })
  it('git exec human result', () => {
    const st = (o: Partial<DevContainerStatus>) => ({ repo: null, tunnel_name: null, branch: 'main', dirty: 0, last_commit: null, ahead: 0, behind: 0, tunnel: 'connected', mise: {}, claude_logged_in: true, uptime_seconds: 0, ...o }) as DevContainerStatus
    const pull = (exitCode: number, output: string, o: Partial<DevContainerStatus> = {}) => gitMsg('pull', { exitCode, output }, st(o))
    expect(pull(128, "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.", { ahead: 1, behind: 3 })).toBe('Pull refused: the branch has diverged (1 ahead, 3 behind). Rebase or merge inside VS Code.')
    expect(pull(1, 'There is no tracking information for the current branch.', { ahead: null, behind: null })).toBe('No upstream branch to pull from. Set one inside VS Code.')
    expect(pull(1, 'You are not currently on a branch.', { branch: 'HEAD', ahead: null, behind: null })).toBe('Pull needs a branch. The workspace is on a detached HEAD.')
    expect(pull(0, 'Already up to date.')).toBe('Already up to date.')
    expect(pull(0, 'Updating a..b\nFast-forward')).toBe('Fast-forwarded.')
    expect(pull(1, 'error: Your local changes would be overwritten by merge')).toBe('Pull failed: Your local changes would be overwritten by merge')
    expect(gitMsg('fetch', { exitCode: 0, output: '   a..b  main -> origin/main' }, st({}))).toBe('Fetched. New commits on origin.')
    expect(gitMsg('fetch', { exitCode: 0, output: '' }, st({ ahead: null }))).toBe('Fetched. No upstream branch, so ahead/behind stay empty.')
    expect(gitMsg('fetch', { exitCode: 128, output: 'fatal: could not read from remote repository' }, st({}))).toBe('Fetch failed: could not read from remote repository')
  })
  it('usage class', () => {
    expect(useCls(69.9)).toBe('')
    expect(useCls(70)).toBe('s-warn')
    expect(useCls(90)).toBe('s-bad')
  })
  it('accent contrast', () => {
    expect(onAccent('#f0c22b')).toBe('var(--ink-dark)')
    expect(onAccent('#2f5bd3')).toBe('var(--ink-light)')
    expect(contrastNote('#f0c22b')).toMatch(/^Label contrast on this accent: \d+\.\d:1 \(passes AA\)$/)
    expect(contrastNote('#777777')).toMatch(/below AA/)
  })
})

describe('meter', () => {
  it('lit math', () => {
    expect(litCount(0, 20)).toBe(0)
    expect(litCount(0.5, 20)).toBe(0)
    expect(litCount(0.6, 20)).toBe(1)
    expect(litCount(4, 10)).toBe(1)
    expect(litCount(50, 20)).toBe(10)
    expect(litCount(100, 10)).toBe(10)
    expect(litCount(150, 10)).toBe(15)
  })
  it('zones', () => {
    const s = segments(100, 10)
    expect(s.slice(0, 7).every(x => x === 'on')).toBe(true)
    expect(s[7]).toBe('w on')
    expect(s[8]).toBe('w on')
    expect(s[9]).toBe('c on')
    expect(segments(0, 20)[19]).toBe('c')
  })
})

describe('deploy', () => {
  const d = (o: Partial<DeployDraft> = {}): DeployDraft => ({ q: '', repo: { fullName: 'a/b', private: true, language: null, defaultBranch: 'main', pushedAt: '', description: null, deployedAs: null }, project: 'shop2', gitName: 'octocat', gitEmail: 'a@b', auth: 'device', token: '', image: 'img', installClaude: true, injectClaudeConfig: false, setupRerun: false, vscodeConfig: true, ghLogin: false, ...o })
  it('slug', () => {
    expect(slug('octocat/Home_Assistant.config')).toBe('home-assistant-confi')
    expect(slug('a/--x--')).toBe('x')
    expect(slug('a/abcdefghijklmnopqrs-uvw')).toBe('abcdefghijklmnopqrs')
  })
  it('errors', () => {
    expect(deployErrors(d(), [])).toEqual({})
    expect(deployErrors(d({ project: '' }), []).project).toBe('Pick a name.')
    expect(deployErrors(d({ project: '-x' }), []).project).toMatch(/lowercase/)
    expect(deployErrors(d({ project: 'a'.repeat(21) }), []).project).toMatch(/20 characters/)
    expect(deployErrors(d(), ['dockbench-shop2']).project).toBe('dockbench-shop2 already exists.')
    expect(Object.keys(deployErrors(d({ repo: null, gitName: ' ', gitEmail: 'nope' }), []))).toEqual(['repo', 'gitName', 'gitEmail'])
  })
})
