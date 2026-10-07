<script setup>
import { useScopedI18n } from '@/i18n/app'
import { useIsMobile } from '../../utils/composables'
import { useGlobalState } from '../../store'
import ThemeToggle from '../../components/ai/ThemeToggle.vue'
import MailIcon from '../../components/ui/MailIcon.vue'

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
const { t: w } = useScopedI18n('workspace')
</script>

<template>
    <div class="workspace-page settings-page">
        <div class="workspace-page-header"><div><div class="workspace-eyebrow">{{ w('account') }}</div><h1>{{ w('appearance') }}</h1><p>{{ w('appearanceSubtitle') }}</p></div><ThemeToggle /></div>
        <!-- 布局与主题卡片 -->
        <div class="settings-section">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <MailIcon name="layers" :size="18" />
                <span>{{ w('layout') }}</span>
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
        <div class="settings-section">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <MailIcon name="shield" :size="18" />
                <span>{{ w('readingSecurity') }}</span>
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
        <div class="settings-section">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
                <MailIcon name="refresh" :size="18" />
                <span>{{ w('synchronization') }}</span>
            </h3>

            <n-form-item-row :label="t('autoRefreshInterval')">
                <n-slider v-model:value="configAutoRefreshInterval" :min="30" :max="120" :step="1" :marks="{
                    30: '30s', 60: '60s', 90: '90s', 120: '120s'
                }" />
            </n-form-item-row>
        </div>
    </div>
</template>
