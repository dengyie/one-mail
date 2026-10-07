<script setup>
import MailIcon from './MailIcon.vue'
defineProps({ icon: { type: String, default: 'inbox' }, title: String, description: String })
</script>

<template>
  <div class="workspace-empty" role="status">
    <div class="workspace-empty__icon"><MailIcon :name="icon" :size="28" /></div>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.default" class="workspace-empty__actions"><slot /></div>
  </div>
</template>
