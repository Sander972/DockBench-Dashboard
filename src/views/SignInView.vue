<script lang="ts">
import { watch } from 'vue'
import { store } from '../store'

// sign-out clears store.host, so the Signed out plate keeps the last host name seen
let lastHost = ''
watch(() => store.host?.name, n => { if (n) lastHost = n })
</script>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { showDenied, signInGithub, signInPasskey } from '../store'
import AppIcon from '../components/AppIcon.vue'
import Led from '../components/Led.vue'

// the OAuth callback comes back here with ?error=denied&login=x, or ?error=oauth after a cancel or a failed exchange
const q = useRoute().query
if (q.error === 'denied') showDenied(String(q.login || 'an unknown account'))
else if (q.error) store.signin = { busy: null, msg: 'GitHub sign-in was cancelled or did not finish. Try again.', denied: null }

// before the first sign-in the host is unknown, so the plate names the address the dashboard is reached at
const host = lastHost || location.hostname

// after GitHub the callback lands on ?step=totp and the server holds a 5-minute pending cookie until the authenticator code checks out
const totpStep = ref(q.step === 'totp')
const code = ref('')
const sending = ref(false)
// the six boxes only draw `code`: one transparent input lies over them, so paste, SMS/authenticator autofill and backspace stay native
const otp = ref<'' | 'checking' | 'ok' | 'bad'>('')
const pasted = ref(false)
const pause = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450
function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  const before = code.value.length
  // no maxlength: it would cut a pasted "123 456" before the spaces are stripped
  code.value = el.value = el.value.replace(/\D/g, '').slice(0, 6)
  // a paste or an autofill lands several digits at once, which the boxes reveal one after another
  pasted.value = code.value.length - before > 1
  if (code.value.length === 6) sendCode()
}
// the caret always sits after the last digit, which is the box drawn as active
function pinCaret(e: Event) {
  const el = e.target as HTMLInputElement
  el.setSelectionRange(el.value.length, el.value.length)
}
function onKey(e: KeyboardEvent) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) e.preventDefault()
}
async function sendCode() {
  if (sending.value) return
  sending.value = true
  otp.value = 'checking'
  store.signin = { busy: null, msg: '', denied: null }
  const r = await fetch('/api/auth/totp', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value }) }).catch(() => null)
  // full load, so init() fetches the new session instead of the cached signed-out one
  if (r?.ok) {
    otp.value = 'ok'
    return setTimeout(() => location.assign('/bench'), pause)
  }
  otp.value = 'bad'
  // readonly, not disabled, while the boxes shake: the input keeps focus, so the phone keyboard stays open for the next try
  setTimeout(() => { code.value = ''; otp.value = ''; sending.value = false }, pause)
  if (r?.status === 401) totpStep.value = false
  const msg = !r ? 'The dashboard did not answer. Try again.'
    : r.status === 401 ? 'The code step expired. Continue with GitHub again.'
    : r.status === 429 ? 'Too many wrong codes. Wait 15 minutes, then try again.'
    : 'That code is wrong or was already used. Enter the current one from your authenticator app.'
  store.signin = { busy: null, msg, denied: null }
}
</script>

<template>
  <div class="lock">
    <div class="lock-plate">
      <div class="brand"><span class="key" aria-hidden="true"></span><span class="word">DockBench</span><span class="host num">{{ store.host?.name || host }}</span></div>
      <div style="display:grid;gap:10px">
        <h1>{{ store.signedOut ? 'Signed out' : 'Sign in' }}</h1>
        <p class="fine">This dashboard can deploy, stop and run git in your dev containers. Only its owner's GitHub account is allowed in.</p>
      </div>
      <form v-if="totpStep" style="display:grid;gap:8px" @submit.prevent="sendCode">
        <label for="totp">6-digit code from your authenticator app</label>
        <div class="otp" :class="otp">
          <input id="totp" :value="code" class="otp-inp" inputmode="numeric" autocomplete="one-time-code" pattern="\d{6}" required autofocus :readonly="sending" @input="onInput" @focus="pinCaret" @click="pinCaret" @keydown="onKey">
          <span v-for="i in 6" :key="i" class="otp-cell" :class="{ on: !sending && i - 1 === Math.min(code.length, 5), full: !!code[i - 1] }" :style="{ '--i': i - 1 }" aria-hidden="true">
            <Transition name="dig"><span v-if="code[i - 1]" :key="code[i - 1]" class="num" :style="{ animationDelay: pasted ? `${(i - 1) * 45}ms` : '' }">{{ code[i - 1] }}</span></Transition>
          </span>
        </div>
        <button type="submit" class="btn pri full" :disabled="sending">{{ otp === 'ok' ? 'Verified' : sending ? 'Checking…' : 'Verify' }}</button>
      </form>
      <div v-else style="display:grid;gap:4px">
        <button id="signinBtn" type="button" class="btn pri full" :disabled="!!store.signin.busy" @click="signInGithub"><AppIcon name="login" /> {{ store.signin.busy === 'github' ? 'Waiting for GitHub…' : 'Continue with GitHub' }}</button>
        <button id="pkBtn" type="button" class="linkbtn" :disabled="!!store.signin.busy" @click="signInPasskey">{{ store.signin.busy === 'passkey' ? 'Waiting for passkey…' : 'Use a passkey instead' }}</button>
      </div>
      <div class="lock-msg" role="status" aria-live="polite">
        <div v-if="store.signin.denied" class="down">
          <b>GitHub says you are {{ store.signin.denied }}.</b>
          <p class="fine">Only the owner's GitHub account may sign in, so no session was created. Sign out of GitHub or switch accounts, then try again.</p>
        </div>
        <div v-else-if="!store.signin.busy && store.signin.msg" class="down">
          <b>Sign-in failed.</b>
          <p class="fine">{{ store.signin.msg }}</p>
        </div>
      </div>
      <ul class="posture">
        <li><Led sev="ok" /><span>Reached through nginx proxy manager. Your address is on its access list.</span></li>
        <li><Led sev="ok" /><span>Your GitHub token never leaves this server. Each dev container gets its own SSH key that opens only its repository.</span></li>
        <li><Led sev="ok" /><span>No password exists for this dashboard, so there is none to steal.</span></li>
        <li><Led sev="ok" /><span>After GitHub, a code from your authenticator app is required too. A passkey added in Settings replaces both.</span></li>
      </ul>
    </div>
  </div>
</template>
