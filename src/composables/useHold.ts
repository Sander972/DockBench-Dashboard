import { onBeforeUnmount, ref } from 'vue'
import { haptic } from '../lib/haptics'

export const HOLD_MS = 900

// Handoff 5.1: press and hold for 900 ms to confirm, with pointer or with Enter / Space. Releasing early calls onEarly.
export function useHold(onConfirm: () => void, onEarly: () => void, disabled: () => boolean = () => false) {
  const holding = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function start() {
    if (disabled() || timer) return
    haptic()
    holding.value = true
    timer = setTimeout(() => {
      timer = undefined
      holding.value = false
      if (disabled()) return
      haptic('confirm')
      onConfirm()
    }, HOLD_MS)
  }
  function end() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
    holding.value = false
    onEarly()
  }
  // like the mockup, any pointerup on the page ends a hold, also a keyboard hold (a click elsewhere must not let it complete)
  document.addEventListener('pointerup', end)
  onBeforeUnmount(() => {
    clearTimeout(timer)
    document.removeEventListener('pointerup', end)
  })

  const isKey = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' '
  const handlers = {
    pointerdown(e: PointerEvent) {
      if (e.button !== 0) return
      e.preventDefault()
      start()
    },
    pointercancel: end,
    pointerleave: end,
    keydown(e: KeyboardEvent) {
      if (!isKey(e)) return
      e.preventDefault()
      if (!e.repeat) start()
    },
    keyup(e: KeyboardEvent) {
      if (isKey(e)) end()
    },
    contextmenu: (e: Event) => e.preventDefault(),
  }
  return { holding, handlers }
}
