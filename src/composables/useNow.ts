import { ref } from 'vue'

// one 1 s clock for the whole app, so relative times tick without re-rendering lists
export const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 1000)

export const useNow = () => now
