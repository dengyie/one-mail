<template>
  <div
    :class="[
      'relative w-full max-w-4xl mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/90 shadow-sm focus-within:ring-2 focus-within:ring-zinc-900/10 dark:focus-within:ring-zinc-100/10 focus-within:border-zinc-400 dark:focus-within:border-zinc-600 transition-all',
      className
    ]"
  >
    <!-- Attachments Preview Area -->
    <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 p-3 pb-0">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="group relative flex items-center gap-2 pl-2 pr-1.5 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-lg border border-zinc-200/80 dark:border-zinc-700/80"
      >
        <span class="max-w-[140px] truncate font-medium">{{ att.name }}</span>
        <button
          type="button"
          @click="$emit('removeAttachment', att.id)"
          class="p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Input Area -->
    <div class="flex items-end px-3 py-2.5 gap-2">
      <template v-if="allowAttachments">
        <input
          ref="fileInputRef"
          type="file"
          multiple
          class="hidden"
          @change="handleFileChange"
          :disabled="disabled || isGenerating"
        />
        <button
          type="button"
          @click="fileInputRef?.click()"
          :disabled="disabled || isGenerating"
          class="p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors disabled:opacity-40"
          title="Add attachment"
        >
          📎
        </button>
      </template>

      <textarea
        ref="textareaRef"
        :value="modelValue"
        @input="handleInput"
        @keydown="handleKeyDown"
        :placeholder="placeholder"
        :disabled="disabled"
        rows="1"
        class="flex-1 bg-transparent resize-none border-0 p-1 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-0 leading-relaxed max-h-[240px] min-h-[36px]"
      ></textarea>

      <!-- Action Button -->
      <button
        v-if="isGenerating"
        type="button"
        @click="$emit('stop')"
        class="p-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl hover:opacity-90 active:scale-95 transition-all shadow-sm flex-shrink-0"
        title="Stop generation"
      >
        ■
      </button>
      <button
        v-else
        type="button"
        @click="handleSubmit"
        :disabled="!modelValue.trim() || disabled"
        class="p-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl hover:opacity-90 active:scale-95 transition-all disabled:opacity-30 disabled:pointer-events-none shadow-sm flex-shrink-0 font-bold"
        title="Send message"
      >
        ↑
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

export interface Attachment {
  id: string;
  name: string;
  url?: string;
  type: 'image' | 'file';
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    isGenerating?: boolean;
    placeholder?: string;
    disabled?: boolean;
    allowAttachments?: boolean;
    attachments?: Attachment[];
    className?: string;
  }>(),
  {
    isGenerating: false,
    placeholder: 'Ask anything... (Enter to send, Shift+Enter for newline)',
    disabled: false,
    allowAttachments: true,
    attachments: () => [],
    className: ''
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'submit'): void;
  (e: 'stop'): void;
  (e: 'addAttachment', file: File): void;
  (e: 'removeAttachment', id: string): void;
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const adjustHeight = () => {
  const textarea = textareaRef.current;
  if (!textarea) return;
  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, 240);
  textarea.style.height = `${Math.max(nextHeight, 48)}px`;
};

const handleInput = (e: Event) => {
  const val = (e.target as HTMLTextAreaElement).value;
  emit('update:modelValue', val);
  adjustHeight();
};

watch(() => props.modelValue, () => {
  nextTick(adjustHeight);
});

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing) return;
    e.preventDefault();
    if (!props.isGenerating && props.modelValue.trim() && !props.disabled) {
      emit('submit');
    }
  }
};

const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) return;
  Array.from(files).forEach((file) => emit('addAttachment', file));
  target.value = '';
};

const handleSubmit = () => {
  if (props.modelValue.trim() && !props.disabled) {
    emit('submit');
  }
};
</script>
