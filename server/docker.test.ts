import { expect, test } from 'bun:test'
import { demux, execRun, logLines, splitImage } from './docker'

const frame = (stream: number, s: string) => {
  const p = Buffer.from(s)
  const h = Buffer.alloc(8)
  h[0] = stream
  h.writeUInt32BE(p.length, 4)
  return Buffer.concat([h, p])
}

test('demux joins stdout and stderr frames and passes a TTY stream through', () => {
  expect(demux(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]))).toBe('out\nerr\n')
  expect(demux(Buffer.from('plain tty text\n'))).toBe('plain tty text\n')
  expect(demux(Buffer.alloc(0))).toBe('')
})

test('log lines lose colors, carriage-return progress and the trailing newline', () => {
  expect(logLines('\x1b[32mok\x1b[0m\r\nReceiving 10%\rReceiving 100%\nlast\n')).toEqual(['ok', 'Receiving 100%', 'last'])
})

test('execRun creates, starts and inspects an exec as dev in the workspace', async () => {
  const seen: { path: string; body: unknown }[] = []
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      seen.push({ path, body: req.method === 'POST' ? await req.json() : null })
      if (path === '/containers/c1/exec') return Response.json({ Id: 'e1' }, { status: 201 })
      if (path === '/exec/e1/start') return new Response(Buffer.concat([frame(1, 'Already up to date.\n'), frame(2, 'hint: x\n')]))
      return Response.json({ ExitCode: 0 })
    },
  })
  const r = await execRun(`http://localhost:${fake.port}`, 'c1', ['git', 'pull', '--ff-only'])
  fake.stop()
  expect(r).toEqual({ exitCode: 0, output: 'Already up to date.\nhint: x\n', calls: [{ method: 'POST', path: '/containers/c1/exec', status: 201 }, { method: 'POST', path: '/exec/e1/start', status: 200 }, { method: 'GET', path: '/exec/e1/json', status: 200 }] })
  expect(seen[0].body).toMatchObject({ User: 'dev', WorkingDir: '/home/dev/workspace', Cmd: ['git', 'pull', '--ff-only'], Env: ['GIT_TERMINAL_PROMPT=0'] })
})

test('execRun options: keep keeps the tail of the output, workDir sets the exec directory', async () => {
  const seen: unknown[] = []
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (req.method === 'POST') seen.push(await req.json())
      if (path === '/containers/c1/exec') return Response.json({ Id: 'e1' }, { status: 201 })
      if (path === '/exec/e1/start') return new Response(frame(1, 'abcdef'))
      return Response.json({ ExitCode: 0 })
    },
  })
  const r = await execRun(`http://localhost:${fake.port}`, 'c1', ['cat', 'f'], { keep: 4, workDir: '/home/dev' })
  fake.stop()
  expect(r.output).toBe('cdef')
  expect(seen[0]).toMatchObject({ WorkingDir: '/home/dev' })
})

test('splitImage handles registry, tag and defaults', () => {
  expect(splitImage('ghcr.io/sander972/dockbench:latest')).toEqual({ name: 'ghcr.io/sander972/dockbench', tag: 'latest', registry: 'ghcr.io' })
  expect(splitImage('ghcr.io/sander972/dockbench')).toEqual({ name: 'ghcr.io/sander972/dockbench', tag: 'latest', registry: 'ghcr.io' })
  expect(splitImage('nginx:1.27')).toEqual({ name: 'nginx', tag: '1.27', registry: 'docker.io' })
  expect(splitImage('library/nginx')).toEqual({ name: 'library/nginx', tag: 'latest', registry: 'docker.io' })
  expect(splitImage('localhost:5000/x/y:dev')).toEqual({ name: 'localhost:5000/x/y', tag: 'dev', registry: 'localhost:5000' })
})
