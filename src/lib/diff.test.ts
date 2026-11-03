import { describe, expect, it } from 'vitest'
import { diffRows } from './diff'

describe('diffRows', () => {
  it('classes a changed file and a new one', () => {
    const text = [
      'diff --git a/settings.json b/settings.json',
      'index a972c06..fec969e 100644',
      '--- a/settings.json',
      '+++ b/settings.json',
      '@@ -109,3 +109,3 @@',
      '   },',
      '-  "model": "opus",',
      '+  "model": "sonnet",',
      'diff --git a/skills/x/SKILL.md b/skills/x/SKILL.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/skills/x/SKILL.md',
      '@@ -0,0 +1 @@',
      '+--- front matter',
      '',
    ].join('\n')
    expect(diffRows(text).map(r => r.kind)).toEqual(['file', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'file', 'meta', 'meta', 'meta', 'hunk', 'add'])
    expect(diffRows(text).filter(r => r.kind === 'file').map(r => r.text)).toEqual(['settings.json', 'skills/x/SKILL.md'])
  })

  it('keeps binary files as a header line', () => {
    expect(diffRows('diff --git a/a.gz b/a.gz\nBinary files /dev/null and b/a.gz differ\n').map(r => r.kind)).toEqual(['file', 'meta'])
  })

  it('is empty for no changes', () => {
    expect(diffRows('')).toEqual([])
  })
})
