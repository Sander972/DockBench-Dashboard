import { checkSessionSecret } from './session'
import { checkTotpSecret } from './totp'

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var ${name}`)
  return v
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  publicUrl: req('PUBLIC_URL').replace(/\/$/, ''),
  githubClientId: req('GITHUB_CLIENT_ID'),
  githubClientSecret: req('GITHUB_CLIENT_SECRET'),
  githubLogin: req('GITHUB_LOGIN'),
  sessionSecret: checkSessionSecret(req('SESSION_SECRET')),
  totpKey: checkTotpSecret(req('TOTP_SECRET')),
  dataDir: process.env.DATA_DIR ?? '/data',
  staticDir: process.env.STATIC_DIR ?? 'dist',
  dockerHost: process.env.DOCKER_HOST ?? '/var/run/docker.sock',
  dockbenchImage: process.env.DOCKBENCH_IMAGE ?? 'ghcr.io/sander972/dockbench:latest',
  portainerUrl: req('PORTAINER_URL').replace(/\/$/, ''),
  portainerApiKey: req('PORTAINER_API_KEY'),
  portainerEndpointId: Number(req('PORTAINER_ENDPOINT_ID')),
  // empty means no collector: usage figures read 0 and host.collector is false
  collectorUrl: (process.env.COLLECTOR_URL ?? 'http://dockbench-collector:9100').replace(/\/$/, ''),
}
