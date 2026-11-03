<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { cancelStepUp, confirmStepUp, deploy, draftErrors, store } from '../store'
import { projHelp, stackVars } from '../lib/deploy'
import StepUpPanel from './StepUpPanel.vue'

const e = draftErrors
const cfgRepo = computed(() => store.session?.claudeConfigRepo ?? '')
const vsSettings = computed(() => store.session?.vscodeSettings ?? '')
const btn = ref<HTMLButtonElement>()
// Esc or Cancel: put focus back on the Deploy button
function cancel() {
  cancelStepUp()
  nextTick(() => btn.value?.focus())
}
</script>

<template>
  <div class="dcol">
    <section class="plate dsec" aria-labelledby="d2">
      <div class="sec-h"><h2 class="lbl" id="d2">2 · Settings</h2><span v-if="store.draft.repo" class="src-note">{{ store.draft.repo.fullName }}</span></div>
      <template v-if="store.draft.repo">
        <div class="field">
          <label for="dProj">Project name</label>
          <div class="affix"><span class="num">dockbench-</span><input id="dProj" v-model="store.draft.project" class="inp num" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="dProjMsg" :aria-invalid="!!e.project"></div>
          <p id="dProjMsg" class="fine" :class="{ 'bad-msg': e.project }">{{ e.project || projHelp(store.draft.project) }}</p>
        </div>
        <div class="field">
          <label for="dName">Commit author name</label>
          <input id="dName" v-model="store.draft.gitName" class="inp" autocomplete="off" spellcheck="false" aria-describedby="dNameMsg" :aria-invalid="!!e.gitName">
          <p id="dNameMsg" class="fine" :class="{ 'bad-msg': e.gitName }">{{ e.gitName }}</p>
        </div>
        <div class="field">
          <label for="dMail">Commit author email</label>
          <input id="dMail" v-model="store.draft.gitEmail" class="inp" type="email" autocomplete="off" spellcheck="false" aria-describedby="dMailMsg" :aria-invalid="!!e.gitEmail">
          <p id="dMailMsg" class="fine" :class="{ 'bad-msg': e.gitEmail }">{{ e.gitEmail }}</p>
        </div>
        <fieldset class="field cc"><legend>Claude Code</legend>
          <label class="check"><input v-model="store.draft.installClaude" type="checkbox"><span>Install Claude Code</span><small>Installed on the first start and updated to the latest release on every restart, with its VS Code extension.</small></label>
          <label class="check"><input v-model="store.draft.injectClaudeConfig" type="checkbox" :disabled="!cfgRepo"><span>Inject my Claude config</span>
            <small v-if="cfgRepo">Checks out <a :href="'https://github.com/' + cfgRepo" target="_blank" rel="noopener">{{ cfgRepo }}</a> over <code>~/.claude</code> on every start, with a read-only deploy key. <RouterLink to="/settings">Change in Settings</RouterLink></small>
            <small v-else>Set your <code>~/.claude</code> repo in <RouterLink to="/settings">Settings</RouterLink> first.</small>
          </label>
        </fieldset>
        <fieldset class="field cc"><legend>VS Code</legend>
          <label class="check"><input v-model="store.draft.vscodeConfig" type="checkbox"><span>Apply my VS Code settings</span>
            <small>Written once, on the first start, as the container's Machine settings. {{ vsSettings ? 'Uses your settings from' : 'Nothing is set in Settings, so the image default is used.' }} <RouterLink to="/settings">{{ vsSettings ? 'Settings' : 'Set them' }}</RouterLink></small>
          </label>
        </fieldset>
        <details>
          <summary>Advanced</summary>
          <div class="field"><label for="dImg">Image</label><input id="dImg" v-model="store.draft.image" class="inp" autocomplete="off" spellcheck="false" aria-describedby="dImgMsg" :aria-invalid="!!e.image"><p id="dImgMsg" class="fine" :class="{ 'bad-msg': e.image }">{{ e.image }}</p></div>
          <label class="check"><input v-model="store.draft.setupRerun" type="checkbox"><span>Run setup.sh on every start</span><small>By default <code>.devcontainer/setup.sh</code> runs once per new container (first deploy, image update). This sets <code>SETUP_RERUN=1</code>.</small></label>
          <label class="check"><input v-model="store.draft.ghLogin" type="checkbox"><span>Sign in with my GitHub account instead of a deploy key</span><small>For a workspace that clones other private repos. No deploy key is made: on the first start <code>gh</code> shows a device code, and its token gives the container access to every repo on your account.</small></label>
        </details>
      </template>
      <p v-else class="fine">Pick a repository first.</p>
    </section>
    <section class="plate dsec" aria-labelledby="d3">
      <div class="sec-h"><h2 class="lbl" id="d3">3 · Review</h2><span class="src-note">Portainer stack</span></div>
      <pre class="term" tabindex="0" aria-label="Stack variables">{{ stackVars(store.draft, cfgRepo, vsSettings) }}</pre>
      <p class="fine">The server pulls the image, then creates the stack with <code>POST /api/stacks/create/standalone/string</code>. It runs the same way as your other stacks.</p>
      <StepUpPanel v-if="store.confirm?.target === 'deploy'" :action="store.confirm.action" :name="'dockbench-' + store.draft.project" :waiting="store.confirm.waiting" @confirm="confirmStepUp" @cancel="cancel" />
      <button v-else id="deployBtn" ref="btn" type="button" class="btn pri full" :disabled="Object.keys(e).length > 0" @click="deploy">Deploy dockbench-{{ store.draft.project || '…' }}</button>
    </section>
  </div>
</template>

<style scoped>
.cc{border:0;padding:0;margin:0;min-inline-size:0}
.cc legend{padding:0;margin-bottom:4px}
</style>
