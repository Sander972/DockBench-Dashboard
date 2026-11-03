import { splitImage } from './docker'

// Copy of DockBench compose.yml with the image made a stack variable and SSH_KEY in place of GITHUB_TOKEN. Keep in sync with compose.yml in the DockBench repo.
export const STACK_FILE = `services:
  dev:
    image: \${DOCKBENCH_IMAGE}
    container_name: dockbench-\${PROJECT}
    hostname: dockbench-\${PROJECT}
    init: true
    environment:
      REPO_URL: \${REPO_URL}
      TUNNEL_NAME: \${PROJECT}
      SSH_KEY: \${SSH_KEY}
      INSTALL_CLAUDE: \${INSTALL_CLAUDE:-1}
      CLAUDE_CONFIG_REPO: \${CLAUDE_CONFIG_REPO:-}
      CLAUDE_CONFIG_KEY: \${CLAUDE_CONFIG_KEY:-}
      GIT_USER_NAME: \${GIT_USER_NAME}
      GIT_USER_EMAIL: \${GIT_USER_EMAIL}
      SETUP_RERUN: \${SETUP_RERUN:-0}
      VSCODE_CONFIG: \${VSCODE_CONFIG:-1}
      VSCODE_SETTINGS: \${VSCODE_SETTINGS:-}
    labels:
      dockbench: "true"
    volumes:
      - home:/home/dev
    networks:
      - devnet
      - proxy
    restart: unless-stopped

volumes:
  home:

networks:
  devnet:
    external: true
  proxy:
    external: true
`

// Copy of compose.yml in the DockBench-telegram repo. Keep in sync with it.
export const TELEGRAM_STACK_FILE = `services:
  telegram:
    image: ghcr.io/sander972/dockbench-telegram:latest
    container_name: dockbench-telegram
    init: true
    environment:
      TELEGRAM_BOT_TOKEN: \${TELEGRAM_BOT_TOKEN}
      TELEGRAM_GROUP_ID: \${TELEGRAM_GROUP_ID:-}
      TELEGRAM_OWNER_ID: \${TELEGRAM_OWNER_ID:-}
      DOCKER_HOST: \${DOCKER_HOST:-unix:///var/run/docker.sock}
    group_add:
      - \${DOCKER_GID}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - state:/data
    networks:
      - devnet
    restart: unless-stopped

volumes:
  state:

networks:
  devnet:
    external: true
`

export interface StackInput {
  project: string
  repo: string
  image: string
  sshKey: string // '' with ghLogin: the image then signs in with gh and clones over https
  gitUserName: string
  gitUserEmail: string
  installClaude: boolean
  setupRerun: boolean
  // owner/name and the base64 private half of its read-only deploy key, both '' when the config is not injected
  claudeConfigRepo: string
  claudeConfigKey: string
  vscodeConfig: boolean
  vscodeSettings: string // settings.json text, '' lets the image seed its own
}

// VS Code settings for the stack: the container writes them once, on a home volume without Machine settings
export const vscodeEnv = (on: boolean, settings: string) => [
  { name: 'VSCODE_CONFIG', value: on ? '1' : '0' },
  { name: 'VSCODE_SETTINGS', value: on && settings ? Buffer.from(settings).toString('base64') : '' },
]

export function stackEnv(i: StackInput): { name: string; value: string }[] {
  return [
    { name: 'PROJECT', value: i.project },
    { name: 'REPO_URL', value: i.sshKey ? `git@github.com:${i.repo}.git` : `https://github.com/${i.repo}.git` },
    { name: 'DOCKBENCH_IMAGE', value: i.image },
    { name: 'SSH_KEY', value: i.sshKey },
    { name: 'INSTALL_CLAUDE', value: i.installClaude ? '1' : '0' },
    { name: 'CLAUDE_CONFIG_REPO', value: i.claudeConfigRepo ? `git@github.com:${i.claudeConfigRepo}.git` : '' },
    { name: 'CLAUDE_CONFIG_KEY', value: i.claudeConfigKey },
    { name: 'GIT_USER_NAME', value: i.gitUserName },
    { name: 'GIT_USER_EMAIL', value: i.gitUserEmail },
    { name: 'SETUP_RERUN', value: i.setupRerun ? '1' : '0' },
    ...vscodeEnv(i.vscodeConfig, i.vscodeSettings),
  ]
}

// true when a stack's variables can be rewritten under the current STACK_FILE without losing git access: it passes SSH_KEY (empty on a ghLogin stack) and DOCKBENCH_IMAGE but never GITHUB_TOKEN, so a stack made by hand or by the first dashboard that signs in with GITHUB_TOKEN is refused
export function fromStackFile(env: { name: string; value: string }[]): boolean {
  const cur = new Map(env.map((e) => [e.name, e.value]))
  return cur.has('SSH_KEY') && !!cur.get('DOCKBENCH_IMAGE') && !cur.get('GITHUB_TOKEN')
}

export interface PortainerConfig {
  url: string
  apiKey: string
  endpointId: number
}

function pf(cfg: PortainerConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(cfg.url + path, { ...init, headers: { 'X-API-Key': cfg.apiKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
}

export interface Stack {
  Id: number
  Name: string
  EndpointId: number
}

export async function createStack(cfg: PortainerConfig, name: string, env: { name: string; value: string }[], file = STACK_FILE): Promise<{ Id: number }> {
  const res = await pf(cfg, `/api/stacks/create/standalone/string?endpointId=${cfg.endpointId}`, { method: 'POST', body: JSON.stringify({ name, stackFileContent: file, env }) })
  if (!res.ok) throw new Error(`Portainer create stack returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<{ Id: number }>
}

// compose up again with the stack's own file and variables (SSH_KEY included, never read out); the caller pulls the image first, so compose sees a new image id behind the same tag and recreates the container. The home volume stays.
export async function redeployStack(cfg: PortainerConfig, id: number): Promise<void> {
  const s = await readStack(cfg, id)
  await putStack(cfg, id, s.file, s.env)
}

export async function readStack(cfg: PortainerConfig, id: number): Promise<{ file: string; env: { name: string; value: string }[] }> {
  const [file, stack] = await Promise.all([pf(cfg, `/api/stacks/${id}/file`), pf(cfg, `/api/stacks/${id}`)])
  if (!file.ok) throw new Error(`Portainer stack file returned ${file.status}`)
  if (!stack.ok) throw new Error(`Portainer stack returned ${stack.status}`)
  const { StackFileContent } = (await file.json()) as { StackFileContent: string }
  const { Env } = (await stack.json()) as { Env: { name: string; value: string }[] | null }
  return { file: StackFileContent, env: Env ?? [] }
}

// compose up with this file and these variables; a changed variable recreates the container, the home volume stays
export async function putStack(cfg: PortainerConfig, id: number, file: string, env: { name: string; value: string }[]): Promise<void> {
  const res = await pf(cfg, `/api/stacks/${id}?endpointId=${cfg.endpointId}`, { method: 'PUT', body: JSON.stringify({ stackFileContent: file, env, prune: false, pullImage: false }) })
  if (!res.ok) throw new Error(`Portainer update stack returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// compose down and forget the stack; Portainer keeps the stack's named volumes, so the caller removes them
export async function deleteStack(cfg: PortainerConfig, id: number): Promise<void> {
  const res = await pf(cfg, `/api/stacks/${id}?endpointId=${cfg.endpointId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Portainer delete stack returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// the variables with these names replaced or added, the rest kept in order
export function patchEnv(env: { name: string; value: string }[], patch: { name: string; value: string }[]): { name: string; value: string }[] {
  const out = env.map((e) => patch.find((p) => p.name === e.name) ?? e)
  return [...out, ...patch.filter((p) => !env.some((e) => e.name === p.name))]
}

// pulls through Portainer's Docker proxy: it swaps {registryId} in X-Registry-Auth for the credentials of that entry under Registries, so private GHCR packages pull with the PAT stored there (the GitHub OAuth token is refused by ghcr.io). A registry Portainer does not know pulls anonymously.
export async function pullImage(cfg: PortainerConfig, image: string): Promise<void> {
  const { name, tag, registry } = splitImage(image)
  const regs = await pf(cfg, '/api/registries')
  if (!regs.ok) throw new Error(`Portainer list registries returned ${regs.status}`)
  const reg = ((await regs.json()) as { Id: number; URL: string }[]).find((r) => r.URL.replace(/^https?:\/\//, '').split('/')[0] === registry)
  const headers: Record<string, string> = reg ? { 'X-Registry-Auth': btoa(JSON.stringify({ registryId: reg.Id })) } : {}
  const res = await pf(cfg, `/api/endpoints/${cfg.endpointId}/docker/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, { method: 'POST', headers })
  const body = await res.text()
  if (!res.ok) throw new Error(`Image pull returned ${res.status}: ${body.slice(0, 300)}`)
  const failed = body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { error?: string }).find((m) => m.error)
  if (failed) throw new Error(`Image pull failed: ${failed.error}`)
}

export async function findStack(cfg: PortainerConfig, name: string): Promise<Stack | null> {
  const res = await pf(cfg, '/api/stacks')
  if (!res.ok) throw new Error(`Portainer list stacks returned ${res.status}`)
  const stacks = (await res.json()) as Stack[]
  return stacks.find((s) => s.Name === name && s.EndpointId === cfg.endpointId) ?? null
}
