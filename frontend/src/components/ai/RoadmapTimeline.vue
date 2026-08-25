<script setup lang="ts">
export interface RoadmapNode {
  id: string | number;
  index: string;
  title: string;
  subtitle?: string;
  stageColor?: string;
  status: "completed" | "active" | "locked";
  tags?: string[];
}

const props = defineProps<{
  nodes: RoadmapNode[];
  activeId?: string | number;
  className?: string;
}>();

const emit = defineEmits<{
  (e: "node-click", node: RoadmapNode): void;
}>();
</script>

<template>
  <div :class="['w-full max-w-4xl mx-auto py-8 font-sans', className || '']">
    <div class="relative flex flex-col md:flex-row items-stretch justify-between gap-4 md:gap-2">
      <!-- 桌面端横向贯穿轨线 -->
      <div class="hidden md:block absolute top-6 left-[4%] right-[4%] h-[2px] bg-[#b3ac97] dark:bg-[#3e444e] -z-0" />
      
      <!-- 移动端竖向贯穿轨线 -->
      <div class="md:hidden absolute top-4 bottom-4 left-6 w-[2px] bg-[#b3ac97] dark:bg-[#3e444e] -z-0" />

      <div
        v-for="node in nodes"
        :key="node.id"
        @click="emit('node-click', node)"
        :class="[
          'relative z-10 flex md:flex-col items-center md:items-start gap-4 md:gap-3 p-3 rounded-lg cursor-pointer transition-all duration-200 group flex-1',
          (activeId === node.id || node.status === 'active')
            ? 'bg-[#faf8f1] dark:bg-[#1b1f26] shadow-sm border border-[#b3ac97]/60 dark:border-[#3e444e]'
            : 'hover:bg-[#faf8f1]/50 dark:hover:bg-[#1b1f26]/50'
        ]"
      >
        <!-- 菱形地标节点 -->
        <div
          :style="{
            borderColor: (activeId === node.id || node.status === 'active' || node.status === 'completed') ? (node.stageColor || '#c2410c') : undefined,
            backgroundColor: node.status === 'completed' ? (node.stageColor || '#c2410c') : (activeId === node.id || node.status === 'active') ? '#faf8f1' : undefined,
          }"
          :class="[
            'w-11 h-11 flex-shrink-0 flex items-center justify-center rotate-45 border-2 rounded-xs transition-transform duration-200 group-hover:scale-105',
            node.status === 'completed'
              ? 'text-white'
              : (activeId === node.id || node.status === 'active')
              ? 'border-2 shadow-xs'
              : 'border-[#b3ac97] dark:border-[#3e444e] bg-[#f1efe7] dark:bg-[#14171c] text-[#8d9298] dark:text-[#6f7268]'
          ]"
        >
          <div class="-rotate-45 font-mono text-xs font-bold flex items-center justify-center">
            <span v-if="node.status === 'completed'">✓</span>
            <span v-else-if="node.status === 'locked'">🔒</span>
            <span v-else :style="{ color: (activeId === node.id || node.status === 'active') ? (node.stageColor || '#c2410c') : undefined }">
              {{ node.index }}
            </span>
          </div>
        </div>

        <!-- 文本 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span
              class="font-mono text-xs tracking-wider uppercase font-semibold"
              :style="{ color: node.stageColor || '#c2410c' }"
            >
              STEP {{ node.index }}
            </span>
            <span
              v-if="node.tags && node.tags.length > 0"
              class="text-[10px] font-mono px-1.5 py-0.5 rounded-xs border border-[#d6d2c2] dark:border-[#2b3038] text-[#545b64] dark:text-[#a9a89c]"
            >
              {{ node.tags[0] }}
            </span>
          </div>

          <h4
            :class="[
              'mt-1 font-serif text-sm md:text-base font-bold truncate leading-tight',
              (activeId === node.id || node.status === 'active')
                ? 'text-[#22262d] dark:text-[#e9e6db]'
                : 'text-[#22262d]/80 dark:text-[#e9e6db]/80 group-hover:text-[#22262d] dark:group-hover:text-[#e9e6db]'
            ]"
          >
            {{ node.title }}
          </h4>

          <p v-if="node.subtitle" class="mt-0.5 text-xs text-[#545b64] dark:text-[#a9a89c] truncate">
            {{ node.subtitle }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
