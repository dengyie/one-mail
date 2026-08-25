<template>
  <div :ref="(el) => { bottomEl = el as HTMLElement; }" :class="['h-px w-full pointer-events-none', className]"></div>

  <!-- Floating Back to Bottom Button -->
  <button
    v-if="!isAtBottom"
    type="button"
    @click="scrollToBottom"
    class="fixed bottom-24 right-8 z-30 p-2.5 rounded-full bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-1.5 text-xs font-medium"
    title="Scroll to bottom"
  >
    <span>↓</span>
    <span v-if="isStreaming" class="w-2 h-2 rounded-full bg-blue-500 animate-ping"></span>
  </button>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    isStreaming?: boolean;
    className?: string;
  }>(),
  {
    isStreaming: false,
    className: ''
  }
);

const bottomEl = ref<HTMLElement | null>(null);
const isAtBottom = ref(true);

const handleScroll = () => {
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const distanceFromBottom = documentHeight - (scrollTop + windowHeight);
  isAtBottom.value = distanceFromBottom < 80;
};

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
});

onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll);
});

watch(
  () => props.isStreaming,
  (streaming) => {
    if (streaming && isAtBottom.value) {
      bottomEl.value?.scrollIntoView({ behavior: 'smooth' });
    }
  }
);

const scrollToBottom = () => {
  bottomEl.value?.scrollIntoView({ behavior: 'smooth' });
};
</script>
