// The Telegram bot (the DockBench-telegram repo) as a dashboard plugin: token check, socket group, setup code from its log, its /status. Kept free of env so tests drive it with fakes.
import { stat } from 'node:fs/promises'
import { dockerFetch } from './docker'
import { HttpError } from './http'

export const TELEGRAM_NAME = 'dockbench-telegram'
export const TELEGRAM_IMAGE = 'ghcr.io/sander972/dockbench-telegram:latest'

export const validToken = (s: unknown): s is string => typeof s === 'string' && /^\d+:[A-Za-z0-9_-]{30,}$/.test(s.trim())

// the bot's @username. The token is in the URL, so no error built here may quote the URL or the fetch error.
export async function getMe(token: string, fetcher: typeof fetch = fetch): Promise<string> {
  let res: Response
  try {
    res = await fetcher(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new HttpError(502, 'Telegram did not answer getMe')
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string }; description?: string } | null
  if (body?.ok && body.result?.username) return body.result.username
  throw new HttpError(res.status === 401 || res.status === 404 ? 400 : 502, `Telegram refused the token: ${(body?.description ?? `HTTP ${res.status}`).slice(0, 300)}`)
}

const names = new Map<string, Promise<string>>()

// The bot's @username from Telegram, asked with the token in the container's own env (read through the Docker socket), once per container. Never taken from /status: that is plain http on devnet, so a dev container answering in the bot's place could point the claim link, and the setup code in it, at a bot of its own.
export function botName(host: string, id: string, fetcher: typeof fetch = fetch): Promise<string> {
  let p = names.get(id)
  if (!p) {
    p = dockerFetch(host, `/containers/${id}/json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ Config: { Env: string[] } }>) : Promise.reject(new Error(`Docker inspect returned ${r.status}`))))
      .then((c) => getMe(c.Config.Env.find((e) => e.startsWith('TELEGRAM_BOT_TOKEN='))?.slice(19).trim() ?? '', fetcher))
    names.set(id, p)
    p.catch(() => names.delete(id))
  }
  return p
}

// group id of the Docker socket the dashboard mounts, which is the host's (DOCKER_GID in the bot stack). null over tcp or when the socket is not there.
export async function dockerGid(host: string): Promise<number | null> {
  if (/^(tcp|http):/.test(host)) return null
  return stat(host).then((s) => s.gid, () => null)
}

// every boot without an owner logs a new code, so the last one is the live one
export function setupCode(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/setup: .* send: \/setup ([0-9a-f]{16})$/)
    if (m) return m[1]
  }
  return null
}

export function telegramEnv(token: string, gid: number): { name: string; value: string }[] {
  return [{ name: 'TELEGRAM_BOT_TOKEN', value: token }, { name: 'DOCKER_GID', value: String(gid) }]
}

// GET /status of the bot
export interface BotStatus {
  bot: string
  owner: boolean
  group: boolean
  topics: { name: string; running: boolean; queued: number }[]
  last_poll_at: string | null
  uptime_seconds: number
}

export async function fetchBotStatus(url: string): Promise<BotStatus> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`/status returned ${res.status}`)
  const s = (await res.json()) as BotStatus
  if (!s || typeof s !== 'object' || !Array.isArray(s.topics)) throw new Error('/status answered something else')
  return s
}
