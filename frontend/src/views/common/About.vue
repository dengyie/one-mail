<script setup>
import { computed } from 'vue'
import { GithubAlt } from '@vicons/fa'
import { useGlobalState } from '../../store'
import { sanitizeHtml } from '../../utils/sanitize-html'
const { announcement } = useGlobalState()
const safeAnnouncement = computed(() => sanitizeHtml(announcement.value))
</script>

<template>
    <div class="center">
        <n-card :bordered="false" embedded>
            <div v-html="safeAnnouncement"></div>
            <n-button tag="a" target="_blank" href="https://github.com/dengyie/one-mail">
                <template #icon>
                    <n-icon :component="GithubAlt" />
                </template>
                Github
            </n-button>
        </n-card>
    </div>
</template>

<style scoped>
.center {
    display: flex;
    justify-content: center;
}

.n-card {
    max-width: 800px;
}

.n-button {
    margin-top: 10px;
    margin-left: 10px;
}
</style>
