<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { cancelStepUp, confirmStepUp, loadTelegram, store, telegramAction } from '../store'
import { prefs } from '../composables/usePrefs'
import { useNow } from '../composables/useNow'
import { botRows, groupLink } from '../lib/telegram'
import Led from '../components/Led.vue'
import StepUpPanel from '../components/StepUpPanel.vue'

const now = useNow()
const t = computed(() => store.telegram)
const rows = computed(() => (t.value?.deployed ? botRows(t.value, now.value) : []))
const bot = computed(() => t.value?.status?.bot ?? '')
const cf = computed(() => (store.confirm?.target.startsWith('telegram-') ? store.confirm : null))
const COPY = {
  'telegram-deploy': 'Creates the Portainer stack dockbench-telegram and starts it: a container that reaches every dev container through the Docker socket.',
  'telegram-claim': 'Shows the one-time code that makes your Telegram account the owner of the bot, with a shell in every dev container.',
  'telegram-update': 'Pulls the newest bot image and recreates dockbench-telegram. A Claude session running right now is stopped; the sessions stay and a reply continues them.',
} as Record<string, string>
// after an error the call left without a status is the one that failed
const codeCls = (n: number | null) => (n == null ? (store.tg.error ? 'code-bad' : 'code-wait') : n < 300 ? 'code-ok' : 'code-bad')

let timer: ReturnType<typeof setInterval> | undefined
const start = () => { clearInterval(timer); timer = setInterval(loadTelegram, prefs.poll * 1000) }
onMounted(() => { loadTelegram(); start() })
watch(() => prefs.poll, start)
onBeforeUnmount(() => { clearInterval(timer); cancelStepUp() })
</script>

<template>
  <div class="page">
    <div class="page-h"><h1>Telegram</h1><p>One forum topic per dev container: a message in topic <code>shop</code> runs Claude Code inside dockbench-shop.</p></div>

    <p v-if="!t" class="fine">Loading…</p>

    <section v-else-if="!t.deployed" class="plate dsec" aria-labelledby="tgNew">
      <div class="sec-h"><h2 class="lbl" id="tgNew">Deploy the bot</h2><span class="src-note">Portainer stack</span></div>
      <p class="fine">Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> (<code>/newbot</code>) and paste the token it gives you. It goes only to Telegram and into the stack.</p>
      <div class="field">
        <label for="tgToken">Bot token</label>
        <input id="tgToken" v-model="store.tg.token" class="inp num" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:AAH…">
      </div>
      <details>
        <summary>Docker group id</summary>
        <div class="field"><label for="tgGid">Docker group id</label><input id="tgGid" v-model="store.tg.gid" class="inp num" inputmode="numeric" autocomplete="off"><p class="fine">Only needed when the dashboard cannot read it itself. On the VPS: <code>stat -c %g /var/run/docker.sock</code></p></div>
      </details>
      <StepUpPanel v-if="cf" :action="cf.action" name="dockbench-telegram" :text="COPY[cf.target]" :waiting="cf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
      <button v-else type="button" class="btn pri full" :disabled="!store.tg.token.trim() || !!store.tg.busy" @click="telegramAction('deploy')">{{ store.tg.busy === 'deploy' ? 'Deploying…' : 'Deploy dockbench-telegram' }}</button>
    </section>

    <section v-else class="plate dsec" aria-labelledby="tgSetup">
      <div class="sec-h"><h2 class="lbl" id="tgSetup">Setup</h2><span v-if="bot" class="src-note">@{{ bot }}</span></div>
      <ol class="steps">
        <li v-for="r in rows" :key="r.key">
          <Led :sev="r.ok ? 'ok' : 'warn'" /> {{ r.text }}
          <template v-if="r.key === 'owner' && !r.ok && rows[0].ok">
            <div v-if="store.tg.claim" class="btns">
              <a class="btn pri" :href="store.tg.claim.link" target="_blank" rel="noopener">Open Telegram and press Start</a>
              <span class="fine">or send <code>/setup {{ store.tg.claim.code }}</code> to @{{ bot }}</span>
            </div>
            <div v-else class="btns"><button type="button" class="btn pri" :disabled="!!store.tg.busy || !!cf" @click="telegramAction('claim')">Claim ownership</button></div>
          </template>
          <template v-if="r.key === 'group' && !r.ok && rows[1].ok && bot">
            <p class="fine">Turn Topics on in the group settings first, then add the bot. Telegram asks to make it admin with Manage topics, Pin messages and Delete messages.</p>
            <div class="btns"><a class="btn pri" :href="groupLink(bot)" target="_blank" rel="noopener">Add to group</a></div>
            <p class="fine">Still not ticked? Send <code>/setup@{{ bot }}</code> in the group: turning Topics on after adding the bot changes the group, and the bot then answers with what is missing.</p>
          </template>
          <ul v-if="r.key === 'topics' && t.status?.topics.length" class="fine">
            <li v-for="x in t.status.topics" :key="x.name"><code>{{ x.name }}</code>{{ x.runs ? ` · ${x.runs} session${x.runs > 1 ? 's' : ''} running` : x.running ? ' · running' : '' }}{{ x.queued ? ` · ${x.queued} queued` : '' }}</li>
          </ul>
        </li>
      </ol>
      <StepUpPanel v-if="cf" :action="cf.action" name="dockbench-telegram" :text="COPY[cf.target]" :waiting="cf.waiting" @confirm="confirmStepUp" @cancel="cancelStepUp" />
      <div v-else class="btns">
        <button type="button" class="btn" :disabled="!!store.tg.busy" @click="telegramAction('update')">{{ store.tg.busy === 'update' ? 'Updating…' : t.imageUpdate ? 'Update to the newest image' : 'Pull and redeploy' }}</button>
      </div>
    </section>

    <div v-if="store.tg.calls.length || store.tg.error" class="plate dsec" aria-live="polite">
      <ol class="trace num"><li v-for="(x, i) in store.tg.calls" :key="i"><span>{{ x.method }}</span><span class="p">{{ x.path }}</span><span :class="codeCls(x.status)">{{ x.status ?? (store.tg.error ? 'failed' : '…') }}</span></li></ol>
      <div v-if="store.tg.error" class="callout bad"><h3><Led sev="bad" />Failed</h3><p>{{ store.tg.error }}</p></div>
    </div>
  </div>
</template>
