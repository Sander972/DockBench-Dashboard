import { expect, test } from 'bun:test'
import { fromStackFile, patchEnv, pullImage, STACK_FILE, TELEGRAM_STACK_FILE, stackEnv } from './portainer'
import { telegramEnv } from './telegram'

test('pullImage goes through the Portainer Docker proxy with the registryId of the matching registry only', async () => {
  const seen: { path: string; auth: string | null }[] = []
  const fake = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/api/registries') return Response.json([{ Id: 3, URL: 'https://ghcr.io' }, { Id: 4, URL: 'registry.example' }])
      seen.push({ path: u.pathname + u.search, auth: req.headers.get('x-registry-auth') })
      return new Response(u.searchParams.get('fromImage') === 'bad' ? '{"status":"x"}\n{"error":"denied"}\n' : '{"status":"ok"}\n')
    },
  })
  const cfg = { url: `http://localhost:${fake.port}`, apiKey: 'k', endpointId: 2 }
  await pullImage(cfg, 'ghcr.io/sander972/dockbench-telegram:latest')
  await pullImage(cfg, 'nginx:1.27')
  const err = await pullImage(cfg, 'bad').catch((e: Error) => e.message)
  fake.stop()
  expect(seen[0].path).toBe('/api/endpoints/2/docker/images/create?fromImage=ghcr.io%2Fsander972%2Fdockbench-telegram&tag=latest')
  // Portainer decodes it with standard base64
  expect(JSON.parse(Buffer.from(seen[0].auth!, 'base64').toString())).toEqual({ registryId: 3 })
  expect(seen[1].auth).toBeNull()
  expect(err).toBe('Image pull failed: denied')
})

test('stackEnv sets every variable the compose file reads, with an ssh clone URL and the deploy key', () => {
  const env = stackEnv({ project: 'shop', repo: 'octocat/shop', image: 'ghcr.io/sander972/dockbench:latest', sshKey: 'LS0tCg==', gitUserName: 'Mona', gitUserEmail: 'a@b.c', installClaude: true, setupRerun: true, claudeConfigRepo: 'octocat/claude-config', claudeConfigKey: 'LS0tCh==', vscodeConfig: true, vscodeSettings: '{ "workbench.colorTheme": "Default Dark Modern" }' })
  const byName = Object.fromEntries(env.map((e) => [e.name, e.value]))
  expect(byName).toEqual({
    PROJECT: 'shop', REPO_URL: 'git@github.com:octocat/shop.git', DOCKBENCH_IMAGE: 'ghcr.io/sander972/dockbench:latest', SSH_KEY: 'LS0tCg==', GIT_USER_NAME: 'Mona', GIT_USER_EMAIL: 'a@b.c', SETUP_RERUN: '1',
    INSTALL_CLAUDE: '1', CLAUDE_CONFIG_REPO: 'git@github.com:octocat/claude-config.git', CLAUDE_CONFIG_KEY: 'LS0tCh==',
    VSCODE_CONFIG: '1', VSCODE_SETTINGS: Buffer.from('{ "workbench.colorTheme": "Default Dark Modern" }').toString('base64'),
  })
  for (const name of Object.keys(byName)) expect(STACK_FILE).toContain(`\${${name}`)
  expect(STACK_FILE).not.toContain('GITHUB_TOKEN')
})

test('stackEnv without a deploy key (ghLogin): empty SSH_KEY and an https clone URL for gh', () => {
  const env = stackEnv({ project: 'shop', repo: 'octocat/shop', image: 'i', sshKey: '', gitUserName: 'Mona', gitUserEmail: 'a@b.c', installClaude: true, setupRerun: false, claudeConfigRepo: '', claudeConfigKey: '', vscodeConfig: false, vscodeSettings: '' })
  expect(Object.fromEntries(env.map((e) => [e.name, e.value]))).toMatchObject({ REPO_URL: 'https://github.com/octocat/shop.git', SSH_KEY: '' })
})

test('stackEnv without Claude: INSTALL_CLAUDE 0 and empty config variables', () => {
  const env = stackEnv({ project: 'shop', repo: 'octocat/shop', image: 'i', sshKey: 'k', gitUserName: 'Mona', gitUserEmail: 'a@b.c', installClaude: false, setupRerun: false, claudeConfigRepo: '', claudeConfigKey: '', vscodeConfig: false, vscodeSettings: '{}' })
  expect(Object.fromEntries(env.map((e) => [e.name, e.value]))).toMatchObject({ SETUP_RERUN: '0', INSTALL_CLAUDE: '0', CLAUDE_CONFIG_REPO: '', CLAUDE_CONFIG_KEY: '', VSCODE_CONFIG: '0', VSCODE_SETTINGS: '' })
})

test('fromStackFile accepts deploy-key and ghLogin stacks, refuses GITHUB_TOKEN and hand-made ones', () => {
  const base = { project: 'p', repo: 'o/r', image: 'ghcr.io/x/dockbench:latest', gitUserName: 'n', gitUserEmail: 'e', installClaude: true, setupRerun: false, claudeConfigRepo: '', claudeConfigKey: '', vscodeConfig: true, vscodeSettings: '' }
  expect(fromStackFile(stackEnv({ ...base, sshKey: 'a2V5' }))).toBe(true)
  expect(fromStackFile(stackEnv({ ...base, sshKey: '' }))).toBe(true)
  // the first dashboard's STACK_FILE: DOCKBENCH_IMAGE plus GITHUB_TOKEN, no SSH_KEY
  expect(fromStackFile([{ name: 'DOCKBENCH_IMAGE', value: base.image }, { name: 'GITHUB_TOKEN', value: 'ghp_x' }])).toBe(false)
  expect(fromStackFile([...stackEnv({ ...base, sshKey: '' }), { name: 'GITHUB_TOKEN', value: 'ghp_x' }])).toBe(false)
  expect(fromStackFile([{ name: 'SSH_KEY', value: 'a2V5' }])).toBe(false)
})

test('patchEnv replaces matching variables in place and appends new ones', () => {
  const env = [{ name: 'A', value: '1' }, { name: 'SSH_KEY', value: 'k' }, { name: 'B', value: '2' }]
  expect(patchEnv(env, [{ name: 'B', value: 'x' }, { name: 'C', value: '3' }])).toEqual([{ name: 'A', value: '1' }, { name: 'SSH_KEY', value: 'k' }, { name: 'B', value: 'x' }, { name: 'C', value: '3' }])
})

test('stack file keeps the DockBench contract', () => {
  expect(STACK_FILE).toContain('container_name: dockbench-${PROJECT}')
  // the tunnel token is encrypted with the hostname: a random one forces a new tunnel login after every recreate
  expect(STACK_FILE).toContain('hostname: dockbench-${PROJECT}')
  expect(STACK_FILE).toContain('TUNNEL_NAME: ${PROJECT}')
  expect(STACK_FILE).toContain('dockbench: "true"')
  expect(STACK_FILE).toContain('- home:/home/dev')
  expect(STACK_FILE).toContain('- devnet')
  expect(STACK_FILE).toContain('- proxy')
})

test('Telegram stack file reads every variable telegramEnv sets and keeps the bot contract', () => {
  for (const { name } of telegramEnv('1:x', 1)) expect(TELEGRAM_STACK_FILE).toContain(`\${${name}}`)
  expect(TELEGRAM_STACK_FILE).toContain('image: ghcr.io/sander972/dockbench-telegram:latest')
  expect(TELEGRAM_STACK_FILE).toContain('container_name: dockbench-telegram')
  expect(TELEGRAM_STACK_FILE).toContain('/var/run/docker.sock:/var/run/docker.sock')
  expect(TELEGRAM_STACK_FILE).toContain('- state:/data')
  expect(TELEGRAM_STACK_FILE).toContain('- devnet')
  // not a dev container: the label would list it on Bench and make the bot open a topic for itself
  expect(TELEGRAM_STACK_FILE).not.toContain('dockbench: "true"')
  expect(TELEGRAM_STACK_FILE).not.toContain('- proxy')
})
