// rows of a git diff for the Claude config changes view: a file row per `diff --git` header (its path only), then git's own lines classed by their first characters
export type DiffKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'ctx'

const META = ['index ', '--- ', '+++ ', 'new file mode', 'deleted file mode', 'old mode', 'new mode', 'similarity index', 'rename from', 'rename to', 'Binary files', '\\ No newline']

export function diffRows(text: string): { kind: DiffKind; text: string }[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let inHunk = false
  return lines.map(l => {
    if (l.startsWith('diff --git ')) { inHunk = false; return { kind: 'file', text: l.slice(l.lastIndexOf(' b/') + 3) } }
    if (l.startsWith('@@')) { inHunk = true; return { kind: 'hunk', text: l } }
    // before the first hunk, `--- a/x` and `+++ b/x` are headers, not changed lines
    if (!inHunk || l.startsWith('\\ No newline')) return { kind: META.some(m => l.startsWith(m)) ? 'meta' : 'ctx', text: l }
    return { kind: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx', text: l }
  })
}
