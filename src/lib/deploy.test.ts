import { describe, expect, it } from 'vitest'
import type { GithubRepo } from '../types'
import { DEFAULT_IMAGE, deployErrors, slug, stackVars, type DeployDraft } from './deploy'

const repo: GithubRepo = { fullName: 'octocat/recipe-box', private: true, language: 'TypeScript', defaultBranch: 'main', pushedAt: '', description: null, deployedAs: null }
const d = (o: Partial<DeployDraft> = {}): DeployDraft => ({
  q: '', repo, project: 'recipe-box', gitName: 'octocat', gitEmail: 'octocat@users.noreply.github.com', auth: 'device', token: '', image: DEFAULT_IMAGE, installClaude: true, injectClaudeConfig: false, setupRerun: false, vscodeConfig: true, ghLogin: false, ...o,
})

describe('slug', () => {
  it('lowercases and replaces runs of other characters with one dash', () => {
    expect(slug('octocat/Recipe_Box.v2')).toBe('recipe-box-v2')
    expect(slug('a/--My Repo--')).toBe('my-repo')
  })
  it('cuts to 20 characters without a trailing dash', () => {
    expect(slug('a/home-assistant-config')).toBe('home-assistant-confi')
    expect(slug('a/abcdefghijklmnopqrs-tuv')).toBe('abcdefghijklmnopqrs')
  })
})

describe('deployErrors', () => {
  it('passes a valid draft', () => expect(deployErrors(d(), [])).toEqual({}))
  it('needs a repo', () => expect(deployErrors(d({ repo: null }), []).repo).toBe('Pick a repository.'))
  it('checks the project name', () => {
    const p = (project: string, names: string[] = []) => deployErrors(d({ project }), names).project
    expect(p('')).toBe('Pick a name.')
    for (const bad of ['Shop', '-shop', 'shop-', 'my_shop', 'my shop']) expect(p(bad)).toBe('Use lowercase letters, digits and dashes, not at the start or end.')
    expect(p('a'.repeat(21))).toBe('Tunnel names are limited to 20 characters.')
    expect(p('a'.repeat(20))).toBeUndefined()
    expect(p('telegram')).toBe('telegram is taken by the Telegram bot.')
    expect(p('shop', ['dockbench-shop'])).toBe('dockbench-shop already exists.')
  })
  it('checks the commit author', () => {
    expect(deployErrors(d({ gitName: '  ' }), []).gitName).toBe('Commits need an author name.')
    expect(deployErrors(d({ gitEmail: 'nope' }), []).gitEmail).toBe('This does not look like an email address.')
  })
  it('needs an image without spaces', () => expect(deployErrors(d({ image: 'a b' }), []).image).toBe('Image names have no spaces.'))
})

describe('stackVars', () => {
  it('lists the stack variables', () => expect(stackVars(d())).toBe(['# stack variables', 'PROJECT=recipe-box', 'REPO_URL=git@github.com:octocat/recipe-box.git', `DOCKBENCH_IMAGE=${DEFAULT_IMAGE}`, 'SSH_KEY=•••••••• (deploy key for this repo, generated on deploy)', 'GIT_USER_NAME=octocat', 'GIT_USER_EMAIL=octocat@users.noreply.github.com', 'SETUP_RERUN=0', 'VSCODE_CONFIG=1', 'VSCODE_SETTINGS=', 'INSTALL_CLAUDE=1', 'CLAUDE_CONFIG_REPO=', 'CLAUDE_CONFIG_KEY='].join('\n')))
  it('marks the VS Code settings only when the option is on and Settings has some', () => {
    const vs = (o: Partial<DeployDraft>, text: string) => stackVars(d(o), '', text).split('\n').filter(l => l.startsWith('VSCODE_'))
    expect(vs({}, '{}')).toEqual(['VSCODE_CONFIG=1', 'VSCODE_SETTINGS=•••••••• (your VS Code settings from Settings, base64)'])
    expect(vs({ vscodeConfig: false }, '{}')).toEqual(['VSCODE_CONFIG=0', 'VSCODE_SETTINGS='])
  })
  it('shows the Claude config repo only when injecting and one is set', () => {
    const tail = (o: Partial<DeployDraft>, repo = '') => stackVars(d(o), repo).split('\n').slice(-3)
    expect(tail({ installClaude: false, injectClaudeConfig: true }, 'octocat/claude-config')).toEqual(['INSTALL_CLAUDE=0', 'CLAUDE_CONFIG_REPO=git@github.com:octocat/claude-config.git', 'CLAUDE_CONFIG_KEY=•••••••• (read-only deploy key for the config repo, generated on deploy)'])
    expect(tail({ injectClaudeConfig: true })).toEqual(['INSTALL_CLAUDE=1', 'CLAUDE_CONFIG_REPO=', 'CLAUDE_CONFIG_KEY='])
    expect(tail({ injectClaudeConfig: false }, 'octocat/claude-config').slice(1)).toEqual(['CLAUDE_CONFIG_REPO=', 'CLAUDE_CONFIG_KEY='])
  })
  it('with ghLogin: https clone URL and no deploy key', () => expect(stackVars(d({ ghLogin: true }))).toContain(`REPO_URL=https://github.com/octocat/recipe-box.git
DOCKBENCH_IMAGE=${DEFAULT_IMAGE}
SSH_KEY= (empty`))
  it('never prints a token', () => expect(stackVars(d({ token: 'github_pat_secret123456789012345' }))).not.toContain('secret'))
  it('uses placeholders before the form is filled', () => expect(stackVars(d({ project: '', repo: null, image: '' }))).toContain(`PROJECT=name\nREPO_URL=\nDOCKBENCH_IMAGE=${DEFAULT_IMAGE}`))
})
