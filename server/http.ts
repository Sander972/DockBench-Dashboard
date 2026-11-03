export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const json = (data: unknown, status = 200): Response => Response.json(data, { status })

// "Android · Chrome" from a User-Agent. Order matters: Edge, Opera and Samsung UAs also say Chrome, Chrome says Safari, iPad says Mac OS X.
export function device(ua: string | null): string {
  if (!ua) return 'unknown device'
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg/.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : null
  return os && browser ? `${os} · ${browser}` : ua.slice(0, 60)
}

export function onError(err: Error): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status)
  console.error(err)
  return json({ error: err.message }, 500)
}
