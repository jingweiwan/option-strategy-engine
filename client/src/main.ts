import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { preloadWatchlistDefaults } from './composables/useWatchlist'
import './styles/tokens.css'
import './styles/app.css'

await preloadWatchlistDefaults()
createApp(App).use(router).mount('#app')
