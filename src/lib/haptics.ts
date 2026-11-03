// Subtle haptic feedback. Android: the Vibration API. iOS Safari 18+ has none, but toggling a native switch input ticks the Taptic Engine, so a hidden one is clicked instead (works only inside a user gesture, like a tap).
const PATTERN: Record<'tap' | 'confirm' | 'error', VibratePattern> = { tap: 8, confirm: 20, error: [12, 60, 12] }
export type Haptic = keyof typeof PATTERN

let iosSwitch: HTMLLabelElement | undefined
function tick() {
  if (!iosSwitch) {
    iosSwitch = document.createElement('label')
    iosSwitch.ariaHidden = 'true'
    iosSwitch.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    iosSwitch.innerHTML = '<input type="checkbox" switch tabindex="-1">'
    document.body.append(iosSwitch)
  }
  iosSwitch.click()
}

export function haptic(kind: Haptic = 'tap') {
  if ('vibrate' in navigator) navigator.vibrate(PATTERN[kind])
  else if (matchMedia('(pointer: coarse)').matches) tick()
}
