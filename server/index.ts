import { env } from './env'
import { onError } from './http'
import { routes } from './routes'

const server = Bun.serve({ port: env.port, routes, error: onError })
console.log(`dockbench dashboard listening on ${server.url}`)
