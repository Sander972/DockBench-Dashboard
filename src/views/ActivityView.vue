<script setup lang="ts">
import { loadActivity, store } from '../store'
import ActivityEvent from '../components/ActivityEvent.vue'

loadActivity()
</script>

<template>
  <div class="page">
    <div class="page-h"><h1>Activity</h1><p>Every sign-in and every write to Docker, newest first. Reads are not logged.</p></div>
    <ul class="evs plate"><ActivityEvent v-for="(e, i) in store.activity" :key="e.at + i" :e="e" /></ul>
  </div>
</template>
