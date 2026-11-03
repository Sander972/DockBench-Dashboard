import { createRouter, createWebHistory } from 'vue-router'
import { cancelStepUp, init, store } from './store'
import BenchView from './views/BenchView.vue'
import SignInView from './views/SignInView.vue'
import { afterPaint } from './lib/paint'

// Bench and sign-in come in the first bundle; the other pages load on their own and are fetched once the first page has painted and the browser is idle, so a tab switch never waits
const views = {
  actions: () => import('./views/ActionsView.vue'),
  deploy: () => import('./views/DeployView.vue'),
  activity: () => import('./views/ActivityView.vue'),
  telegram: () => import('./views/TelegramView.vue'),
  settings: () => import('./views/SettingsView.vue'),
}
afterPaint(() => Object.values(views).forEach(v => v()), true)

export const narrow = () => !matchMedia('(min-width:760px)').matches

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/bench' },
    { path: '/sign-in', name: 'sign-in', component: SignInView, meta: { title: 'Sign in' } },
    // one record for list and detail, so the same BenchView instance stays mounted and the list keeps its scroll
    { path: '/bench/:id?', name: 'bench', component: BenchView, meta: { title: 'Bench' } },
    { path: '/actions', name: 'actions', component: views.actions, meta: { title: 'Actions' } },
    { path: '/deploy', name: 'deploy', component: views.deploy, meta: { title: 'Deploy' } },
    { path: '/activity', name: 'activity', component: views.activity, meta: { title: 'Activity' } },
    { path: '/telegram', name: 'telegram', component: views.telegram, meta: { title: 'Telegram' } },
    { path: '/settings', name: 'settings', component: views.settings, meta: { title: 'Settings' } },
    { path: '/:rest(.*)*', redirect: '/bench' },
  ],
  scrollBehavior(to, from, saved) {
    if (saved) return saved
    // picking a row on wide screens keeps the page where it is
    if (to.name === 'bench' && from.name === 'bench' && !narrow()) return false
    return { top: 0 }
  },
})

router.beforeEach(async to => {
  await init()
  if (!store.session && to.name !== 'sign-in') return { name: 'sign-in' }
  if (store.session && to.name === 'sign-in') return '/bench'
})

// a page chunk of the build this tab started with is gone after a deploy: load the page fresh, which picks up the new build
router.onError((e, to) => {
  if (/dynamically imported module|Importing a module script failed/.test(String(e?.message))) location.assign(to.fullPath)
})

router.afterEach((to, from) => {
  document.title = `${to.meta.title} · DockBench`
  if (to.path !== from.path) cancelStepUp()
})
