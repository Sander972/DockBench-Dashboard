import type { GithubRepo } from '../types'

export interface DeployDraft {
  q: string
  repo: GithubRepo | null
  project: string
  gitName: string
  gitEmail: string
  auth: 'device' | 'token'
  token: string
  image: string
  installClaude: boolean
  injectClaudeConfig: boolean
  setupRerun: boolean
  vscodeConfig: boolean
  ghLogin: boolean
}

export const DEFAULT_IMAGE = 'ghcr.io/sander972/dockbench:latest'

export const slug = (full: string) =>
  full.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '')

export type DeployErrors = Partial<Record<'repo' | 'project' | 'gitName' | 'gitEmail' | 'image', string>>

export function deployErrors(d: DeployDraft, existingNames: string[]): DeployErrors {
  const p = d.project, e: DeployErrors = {}
  if (!d.repo) e.repo = 'Pick a repository.'
  e.project = !p ? 'Pick a name.'
    : !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(p) ? 'Use lowercase letters, digits and dashes, not at the start or end.'
    : p.length > 20 ? 'Tunnel names are limited to 20 characters.'
    : p === 'telegram' ? 'telegram is taken by the Telegram bot.'
    : existingNames.includes('dockbench-' + p) ? `dockbench-${p} already exists.` : ''
  e.gitName = d.gitName.trim() ? '' : 'Commits need an author name.'
  e.gitEmail = /^[^\s@]+@[^\s@]+$/.test(d.gitEmail) ? '' : 'This does not look like an email address.'
  e.image = /\s/.test(d.image) ? 'Image names have no spaces.' : ''
  for (const k in e) if (!e[k as keyof DeployErrors]) delete e[k as keyof DeployErrors]
  return e
}

export const projHelp = (p: string) => `Container dockbench-${p || 'name'} and tunnel "${p || 'name'}". Must be unique on your GitHub account.`
// the stack file is fixed server side (api.md), so Review shows only the variables it gets; the server generates a deploy key for the repo unless ghLogin (and a read-only one for the Claude config repo), the account token never reaches the container
export const stackVars = (d: DeployDraft, configRepo = '', vscodeSettings = '') => {
  const cfg = d.injectClaudeConfig && configRepo
  return ['# stack variables', `PROJECT=${d.project || 'name'}`, `REPO_URL=${!d.repo ? '' : d.ghLogin ? `https://github.com/${d.repo.fullName}.git` : `git@github.com:${d.repo.fullName}.git`}`, `DOCKBENCH_IMAGE=${d.image || DEFAULT_IMAGE}`,
    d.ghLogin ? 'SSH_KEY= (empty: gh asks for a device code on the first start)' : 'SSH_KEY=•••••••• (deploy key for this repo, generated on deploy)', `GIT_USER_NAME=${d.gitName}`, `GIT_USER_EMAIL=${d.gitEmail}`, `SETUP_RERUN=${d.setupRerun ? 1 : 0}`,
    `VSCODE_CONFIG=${d.vscodeConfig ? 1 : 0}`, `VSCODE_SETTINGS=${d.vscodeConfig && vscodeSettings ? '•••••••• (your VS Code settings from Settings, base64)' : ''}`,
    `INSTALL_CLAUDE=${d.installClaude ? 1 : 0}`, `CLAUDE_CONFIG_REPO=${cfg ? `git@github.com:${configRepo}.git` : ''}`, `CLAUDE_CONFIG_KEY=${cfg ? '•••••••• (read-only deploy key for the config repo, generated on deploy)' : ''}`].join('\n')
}
