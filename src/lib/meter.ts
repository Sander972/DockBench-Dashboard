export const litCount = (pct: number, n: number) => (pct > 0.5 ? Math.max(1, Math.round((pct / 100) * n)) : 0)

export function zone(i: number, n: number): '' | 'w' | 'c' {
  const pos = (i + 1) / n
  return pos > 0.9 ? 'c' : pos > 0.7 ? 'w' : ''
}

// class string per segment, e.g. ['on', 'on', '', ..., 'w', 'c'], ready for <i :class>
export function segments(pct: number, n: number) {
  const lit = litCount(pct, n)
  return Array.from({ length: n }, (_, i) => [zone(i, n), i < lit ? 'on' : ''].filter(Boolean).join(' '))
}
