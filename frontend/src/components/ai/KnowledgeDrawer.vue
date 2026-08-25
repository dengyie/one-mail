<script setup lang="ts">
export interface KnowledgeDependency {
  type: "dependency" | "branch" | "parallel" | "convergent";
  label: string;
}

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    index: string;
    title: string;
    subtitle?: string;
    themeColor?: string;
    conceptText?: string;
    dependencies?: KnowledgeDependency[];
    actionLabel?: string;
    className?: string;
  }>(),
  {
    themeColor: "#c2410c",
    actionLabel: "开始该阶段练习",
    dependencies: () => [],
  }
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "action"): void;
}>();
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 overflow-hidden flex justify-end font-sans">
    <!-- 背景蒙层 -->
    <div
      class="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-300"
      @click="emit('close')"
    />

    <!-- 侧边抽屉 -->
    <div
      :style="{ borderLeftColor: themeColor }"
      :class="[
        'relative z-10 w-full max-w-md bg-[#faf8f1] dark:bg-[#1b1f26] h-full shadow-2xl border-l-4 flex flex-col transform transition-transform duration-300 ease-out',
        className || ''
      ]"
    >
      <!-- 头部 -->
      <div class="p-5 border-b border-[#d6d2c2] dark:border-[#2b3038] flex items-start justify-between gap-4 bg-[#f1efe7]/50 dark:bg-[#14171c]/50">
        <div class="flex items-start gap-3 min-w-0">
          <span
            class="font-mono text-2xl font-black leading-none"
            :style="{ color: themeColor }"
          >
            {{ index }}
          </span>
          <div class="min-w-0">
            <h3 class="font-serif text-lg font-bold text-[#22262d] dark:text-[#e9e6db] leading-snug truncate">
              {{ title }}
            </h3>
            <p v-if="subtitle" class="text-xs text-[#545b64] dark:text-[#a9a89c] mt-0.5">
              {{ subtitle }}
            </p>
          </div>
        </div>

        <button
          type="button"
          @click="emit('close')"
          class="p-1.5 rounded-sm hover:bg-[#e7e4d7] dark:hover:bg-[#0f1216] text-[#545b64] dark:text-[#a9a89c] transition-colors"
        >
          ✕
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-5 space-y-6">
        <div v-if="conceptText">
          <div class="flex items-center gap-1.5 text-xs font-mono font-bold tracking-widest text-[#8d9298] dark:text-[#6f7268] uppercase mb-2">
            <span>核心要点与认知</span>
          </div>
          <p class="text-sm leading-relaxed text-[#22262d] dark:text-[#e9e6db] bg-[#f1efe7]/60 dark:bg-[#14171c]/60 p-3.5 rounded-sm border border-[#d6d2c2]/80 dark:border-[#2b3038]">
            {{ conceptText }}
          </p>
        </div>

        <div v-if="dependencies && dependencies.length > 0">
          <div class="flex items-center gap-1.5 text-xs font-mono font-bold tracking-widest text-[#8d9298] dark:text-[#6f7268] uppercase mb-2">
            <span>拓扑前置与分支关系</span>
          </div>
          <div class="space-y-2">
            <div
              v-for="(dep, idx) in dependencies"
              :key="idx"
              class="flex items-center gap-2.5 text-xs p-2 rounded border border-[#d6d2c2] dark:border-[#2b3038] bg-white/50 dark:bg-black/20"
            >
              <span
                class="font-mono text-[10px] uppercase px-1.5 py-0.5 rounded border tracking-wider"
                :style="{
                  borderColor: dep.type === 'dependency' ? '#8d9298' : dep.type === 'branch' ? '#1d4ed8' : themeColor,
                  color: dep.type === 'dependency' ? '#545b64' : dep.type === 'branch' ? '#1d4ed8' : themeColor,
                }"
              >
                {{ dep.type }}
              </span>
              <span class="text-[#545b64] dark:text-[#a9a89c] font-medium">
                {{ dep.label }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部按钮 -->
      <div class="p-4 border-t border-[#d6d2c2] dark:border-[#2b3038] bg-[#f1efe7]/30 dark:bg-[#14171c]/30">
        <button
          type="button"
          @click="emit('action')"
          :style="{ backgroundColor: themeColor, borderColor: themeColor }"
          class="w-full py-2.5 px-4 text-white font-serif font-bold text-sm rounded-sm shadow-sm hover:brightness-105 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
        >
          <span>{{ actionLabel }}</span>
          <span>→</span>
        </button>
      </div>
    </div>
  </div>
</template>
