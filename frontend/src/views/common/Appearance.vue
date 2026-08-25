<script setup>
import { useScopedI18n } from '@/i18n/app'
import { useIsMobile } from '../../utils/composables'
import { useGlobalState } from '../../store'
import ThemeToggle from '../../components/ai/ThemeToggle.vue'

const props = defineProps({
    showUseSimpleIndex: {
        type: Boolean,
        default: false
    }
})

const {
    mailboxSplitSize, mailListView, mailListPreviewLineClamp, useIframeShowMail, preferShowTextMail, configAutoRefreshInterval,
    globalTabplacement, useSideMargin, useUTCDate, useSimpleIndex, autoLoadRemoteImages
} = useGlobalState()
const isMobile = useIsMobile()

const { t } = useScopedI18n('views.common.Appearance')
</script>

<template>
    <div class="max-w-4xl mx-auto px-4 py-6 space-y-6 text-left">
        <!-- 页面标题与主题切换器 -->
        <div class="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-200 dark:border-zinc-800">
            <div>
                <h2 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <span>🎨</span>
                    <span>{{ t('title') || '外观与体验设置' }}</span>
                </h2>
                <p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">自定义主题配色、分栏布局与邮件渲染偏好</p>
            </div>
            <ThemeToggle />
        </div>

        <!-- 布局与主题卡片 -->
        <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 shadow-xs space-y-4">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <span>📐</span>
                <span>界面布局</span>
            </h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <n-form-item-row v-if="!isMobile" :label="t('mailboxSplitSize')">
                    <n-slider v-model:value="mailboxSplitSize" :min="0" :max="0.75" :step="0.01" :marks="{
                        0: '0',
                        0.25: '0.25',
                        0.5: '0.5',
                        0.75: '0.75'
                    }" />
                </n-form-item-row>

                <n-form-item-row v-if="!isMobile" :label="t('mailListPreviewLineClamp')">
                    <n-slider v-model:value="mailListPreviewLineClamp" :min="0" :max="5" :step="1" :marks="{
                        0: t('off'),
                        1: '1',
                        2: '2',
                        3: '3',
                        4: '4',
                        5: '5'
                    }" />
                </n-form-item-row>

                <n-form-item-row v-if="!isMobile" :label="t('mailListView')">
                    <n-switch v-model:value="mailListView" :round="false" />
                </n-form-item-row>

                <n-form-item-row v-if="props.showUseSimpleIndex" :label="t('useSimpleIndex')">
                    <n-switch v-model:value="useSimpleIndex" :round="false" />
                </n-form-item-row>

                <n-form-item-row v-if="!isMobile" :label="t('useSideMargin')">
                    <n-switch v-model:value="useSideMargin" :round="false" />
                </n-form-item-row>

                <n-form-item-row :label="t('globalTabplacement')">
                    <n-radio-group v-model:value="globalTabplacement" size="small">
                        <n-radio-button value="top" :label="t('top')" />
                        <n-radio-button value="left" :label="t('left')" />
                        <n-radio-button value="right" :label="t('right')" />
                        <n-radio-button value="bottom" :label="t('bottom')" />
                    </n-radio-group>
                </n-form-item-row>
            </div>
        </div>

        <!-- 邮件阅读与安全卡片 -->
        <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 shadow-xs space-y-4">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <span>📧</span>
                <span>邮件阅读与安全</span>
            </h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <n-form-item-row :label="t('preferShowTextMail')">
                    <n-switch v-model:value="preferShowTextMail" :round="false" />
                </n-form-item-row>

                <n-form-item-row :label="t('useIframeShowMail')">
                    <n-switch v-model:value="useIframeShowMail" :round="false" />
                </n-form-item-row>

                <n-form-item-row :label="t('useUTCDate')">
                    <n-switch v-model:value="useUTCDate" :round="false" />
                </n-form-item-row>

                <n-form-item-row :label="t('autoLoadRemoteImages')">
                    <n-switch v-model:value="autoLoadRemoteImages" :round="false" />
                </n-form-item-row>
            </div>
        </div>

        <!-- 自动刷新与同步 -->
        <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 shadow-xs space-y-4">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <span>⏱️</span>
                <span>数据同步</span>
            </h3>

            <n-form-item-row :label="t('autoRefreshInterval')">
                <n-slider v-model:value="configAutoRefreshInterval" :min="30" :max="300" :step="1" :marks="{
                    60: '60s', 120: '120s', 180: '180s', 240: '240s'
                }" />
            </n-form-item-row>
        </div>
    </div>
</template>
