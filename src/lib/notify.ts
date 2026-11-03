import { prefs } from '../composables/usePrefs'

export const canNotify = () => 'Notification' in window && 'serviceWorker' in navigator

// asked from the Settings switch, since browsers grant it only inside a tap
export async function enableNotify() {
  if (!canNotify()) return false
  // the worker is checked after the prompt, which browsers show only while the tap is fresh
  prefs.notify = (await Notification.requestPermission()) === 'granted' && !!(await navigator.serviceWorker.getRegistration())
  return prefs.notify
}

// on, and the browser still lets it show: a permission revoked in the site settings turns it off without the switch knowing
export const notifyOn = () => prefs.notify && canNotify() && Notification.permission === 'granted'

// A system notification, only while the dashboard is not in front (the toast says it otherwise). It goes through the service worker: Android has no `new Notification()`, and a tap focuses the dashboard on `url`. One tag per subject, so a newer note replaces an older one instead of piling up.
export async function notify(body: string, tag: string, url = location.pathname) {
  if (!notifyOn()) return
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  try {
    // not `ready`, which never settles when no worker is registered
    const reg = await navigator.serviceWorker.getRegistration()
    await reg?.showNotification('DockBench', { body, tag, data: { url }, icon: '/icons/icon-192.png', badge: '/favicon.png' })
  } catch { /* blocked or no worker: the toast still shows on return */ }
}
