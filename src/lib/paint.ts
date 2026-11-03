// Runs fn once the browser has painted the next frame (a task queued from requestAnimationFrame runs after that frame's paint), so network work never delays first paint. idle also waits for an idle period, for work nobody waits on.
export function afterPaint(fn: () => void, idle = false) {
  requestAnimationFrame(() => setTimeout(() => {
    if (idle && 'requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 3000 })
    else fn()
  }))
}

export const painted = () => new Promise<void>(r => afterPaint(r))
