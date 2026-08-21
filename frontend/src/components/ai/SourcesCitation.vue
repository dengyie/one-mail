<template>
  <div v-if="sources && sources.length > 0" :class="['my-3 space-y-2', className]">
    <div class="flex items-center gap-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
      <span>🌐</span>
      <span>Sources ({{ sources.length }})</span>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
      <a
        v-for="(item, idx) in sources"
        :key="item.id || idx"
        :href="item.url"
        target="_blank"
        rel="noopener noreferrer"
        class="group relative flex flex-col justify-between p-2.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700 shadow-xs transition-all no-underline"
      >
        <div class="space-y-1">
          <div class="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
            <span class="flex items-center justify-center w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-bold text-[10px]">
              {{ idx + 1 }}
            </span>
            <span class="truncate max-w-[120px]">{{ getDomain(item.url, item.siteName) }}</span>
          </div>
          <div class="text-xs font-medium text-zinc-800 dark:text-zinc-200 line-clamp-2 leading-snug group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {{ item.title }}
          </div>
        </div>

        <div v-if="item.snippet" class="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2 leading-tight">
          {{ item.snippet }}
        </div>

        <div class="mt-2 flex items-center justify-end text-[10px] text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300">
          <span class="opacity-0 group-hover:opacity-100 transition-opacity">↗</span>
        </div>
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface SourceItem {
  id?: string | number;
  title: string;
  url: string;
  snippet?: string;
  siteName?: string;
  favicon?: string;
}

withDefaults(
  defineProps<{
    sources: SourceItem[];
    className?: string;
  }>(),
  {
    className: ''
  }
);

const getDomain = (url: string, siteName?: string) => {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return siteName || 'web';
  }
};
</script>
