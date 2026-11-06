import type { DevContainerStatus } from '../types'

export const GiB = 1024 ** 3
export const DISK_BUDGET = 20 * GiB // per container, dashboard setting
export const toGiB = (bytes: number) => bytes / GiB

// ms timestamp or ISO string
export type Time = number | string
export const ms = (t: Time) => (typeof t === 'string' ? Date.parse(t) : t)

export function dur(sec: number) {
  sec = Math.max(0, Math.floor(sec))
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}
export const since = (t: Time, now = Date.now()) => dur((now - ms(t)) / 1000)
export const ago = (t: Time, now = Date.now()) => since(t, now) + ' ago'

// both take GiB, like the mockup: gib(3.44) = "3.44", short(3.62) = "3.6G"
export const gib = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2))
export const short = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + 'G'

export const clock = (t: Time) => new Date(ms(t)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
export function when(t: Time, now = Date.now()) {
  const d = new Date(ms(t))
  if (d.toDateString() === new Date(now).toDateString()) return clock(t)
  return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + clock(t)
}

// repo link normalized as the API doc specifies
export function repoUrl(r: string | null | undefined) {
  if (!r) return null
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return 'https://github.com/' + r.replace(/\.git$/, '')
  let u = r.replace(/\.git$/, '')
  const m = u.match(/^git@([^:]+):(.+)$/)
  if (m) u = `https://${m[1]}/${m[2]}`
  return u
}
export const repoLabel = (r: string | null | undefined) => (repoUrl(r) || '').replace(/^https:\/\/github\.com\//, '')

// row context line: render parts joined with " · ", num parts in the mono face
export function gitParts(st: DevContainerStatus | null): { text: string; num: boolean }[] {
  if (!st) return []
  const detached = st.branch === 'HEAD'
  const parts = [{ text: detached ? 'detached HEAD' : st.branch ?? '', num: false }]
  if (st.dirty != null) parts.push({ text: st.dirty === 0 ? 'clean' : `${st.dirty} changed`, num: false })
  if (!detached) {
    if (st.ahead == null) parts.push({ text: 'no upstream', num: false })
    else if (st.ahead || st.behind) parts.push({ text: `↑${st.ahead} ↓${st.behind}`, num: true })
    else parts.push({ text: 'in sync', num: false })
  }
  return parts.filter(p => p.text)
}

// one-line human result of a git fetch/pull exec, from the exit code, the output and the /status seen before the run
export function gitMsg(kind: 'fetch' | 'pull', x: { exitCode: number | null; output: string }, st: DevContainerStatus | null | undefined) {
  const out = x.output
  const fatal = out.split('\n').reverse().find(l => /^(fatal|error):/.test(l))
  if (x.exitCode && (/not currently on a branch/i.test(out) || st?.branch === 'HEAD')) return `${kind === 'fetch' ? 'Fetch' : 'Pull'} needs a branch. The workspace is on a detached HEAD.`
  if (kind === 'fetch') {
    if (x.exitCode) return fatal ? `Fetch failed: ${fatal.replace(/^\w+:\s*/, '')}` : `Fetch failed with exit ${x.exitCode}.`
    if (st && st.ahead == null) return 'Fetched. No upstream branch, so ahead/behind stay empty.'
    return / -> /.test(out) ? 'Fetched. New commits on origin.' : 'Fetched. Nothing new on origin.'
  }
  if (!x.exitCode) return /up to date/i.test(out) ? 'Already up to date.' : 'Fast-forwarded.'
  if (/no tracking information/i.test(out) || (st && st.branch && st.ahead == null)) return 'No upstream branch to pull from. Set one inside VS Code.'
  if (/diverg|not possible to fast-forward/i.test(out)) return `Pull refused: the branch has diverged${st?.ahead != null ? ` (${st.ahead} ahead, ${st.behind} behind)` : ''}. Rebase or merge inside VS Code.`
  return fatal ? `Pull failed: ${fatal.replace(/^\w+:\s*/, '')}` : `Pull failed with exit ${x.exitCode}.`
}

// a usage figure is only colored once it needs attention; below 70% it stays plain text
export const useCls = (p: number) => (p >= 90 ? 's-bad' : p >= 70 ? 's-warn' : '')

export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
// whichever ink contrasts more with the accent
export function onAccent(hex: string) {
  const L = luminance(hex)
  return (L + 0.05) / 0.06 >= 0.95 / (L + 0.05) ? 'var(--ink-dark)' : 'var(--ink-light)'
}
export function contrastNote(hex: string) {
  const L = luminance(hex), r = Math.max((L + 0.05) / 0.06, 0.95 / (L + 0.05))
  return `Label contrast on this accent: ${r.toFixed(1)}:1 ${r >= 4.5 ? '(passes AA)' : '(below AA, pick a lighter or darker shade)'}`
}
