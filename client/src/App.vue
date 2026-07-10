<script setup lang="ts">
import Sidebar from '@/components/Sidebar.vue'
import Topbar from '@/components/Topbar.vue'
import Tweaks from '@/components/Tweaks.vue'
</script>

<template>
  <div class="shell">
    <Sidebar />
    <main class="main">
      <Topbar />
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <Tweaks />
  </div>
</template>
