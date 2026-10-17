<script setup>
import { ref, onMounted, computed, watch, onBeforeUnmount } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useMessage } from 'naive-ui'
import {
    ExitToAppFilled,
    ContentCopyFilled,
    RefreshFilled,
    ArrowBackIosNewFilled,
    ArrowForwardIosFilled,
    SettingsFilled
} from '@vicons/material'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import Login from '../common/Login.vue'
import AccountSettings from './AccountSettings.vue'
import { processItem, revokeProcessedItemUrls } from '../../utils/email-parser'
import MailContentRenderer from '../../components/MailContentRenderer.vue'
import AddressSelect from '../../components/AddressSelect.vue'

const { jwt, settings, useSimpleIndex, showAddressCredential, openSettings, loading, configAutoRefreshInterval } = useGlobalState()
const message = useMessage()

// 邮件数据
const currentPage = ref(1)
const totalCount = ref(0)
const currentMail = ref(null)
const showAccountSettingsCard = ref(false)
const currentAutoRefreshInterval = ref(Number(configAutoRefreshInterval.value) || 10)
const timer = ref(null)
let mailRequestSeq = 0;
let simpleMounted = false;

watch(configAutoRefreshInterval, (newInterval) => {
    currentAutoRefreshInterval.value = Number(newInterval) || 10
})

const { t } = useScopedI18n('views.index.SimpleIndex')

const replaceCurrentMail = (nextMail) => {
    const previousMail = currentMail.value;
    currentMail.value = nextMail;
    if (previousMail && previousMail !== nextMail) {
        revokeProcessedItemUrls(previousMail);
    }
};

// 复制地址
const copyAddress = async () => {
    try {
        await navigator.clipboard.writeText(settings.value.address)
        message.success(t('addressCopied'))
    } catch (error) {
        message.error('复制失败')
    }
}

// 获取邮件数据
// withCount=false 用于后台轮询：COUNT(*) 是 D1 rows_read 的主要消耗方，
// 而总数在两次轮询之间不会变；返回 null 时保留旧值，不能当成 0（那是「没算」）。
const fetchMails = async ({ withCount = true } = {}) => {
    const requestId = ++mailRequestSeq;
    if (!settings.value.address) {
        replaceCurrentMail(null);
        totalCount.value = 0;
        return;
    }
    try {
        const { results, count } = await api.fetch(`/api/mails?limit=1&offset=${currentPage.value - 1}&with_count=${withCount ? 1 : 0}`)
        const rawMail = results && results.length > 0 ? results[0] : null
        const nextMail = rawMail ? await processItem(rawMail) : null;
        if (requestId !== mailRequestSeq) {
            if (nextMail) revokeProcessedItemUrls(nextMail);
            return;
        }
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
            totalCount.value = count;
        }
        replaceCurrentMail(nextMail);
    } catch (error) {
        if (requestId !== mailRequestSeq) return;
        console.error('Failed to fetch mails:', error)
        message.error('获取邮件失败')
    }
}

// 删除邮件
const deleteMail = async () => {
    if (!currentMail.value) return;
    try {
        await api.fetch(`/api/mails/${currentMail.value.id}`, { method: 'DELETE' });
        message.success(t('deleteSuccess'));
        replaceCurrentMail(null);
        await refreshMails();
    } catch (error) {
        console.error('Failed to delete mail:', error);
        message.error('删除邮件失败');
    }
}

// 刷新邮件
// background=true 是自动轮询路径：不算总数，也不弹成功提示（每 10s 弹一次太吵）。
const refreshMails = async ({ background = false } = {}) => {
    if (loading.value) return
    currentPage.value = 1
    showAccountSettingsCard.value = false
    currentAutoRefreshInterval.value = Number(configAutoRefreshInterval.value) || 10
    await fetchMails({ withCount: !background })
    if (!background) message.success(t('refreshSuccess'))
}

// 分页控制
const currentPageDisplay = computed(() => currentPage.value)
const totalPages = computed(() => Math.max(1, totalCount.value))
const canGoPrev = computed(() => currentPage.value > 1)
const canGoNext = computed(() => currentPage.value < totalPages.value)
const isFirstPage = computed(() => currentPage.value === 1)

const prevPage = async () => {
    if (canGoPrev.value) {
        currentPage.value--
    }
}

const nextPage = async () => {
    if (canGoNext.value) {
        currentPage.value++
    }
}

// 监听页面变化
watch(currentPage, () => {
    fetchMails()
})

watch(() => settings.value.address, (address, previousAddress) => {
    if (!simpleMounted || address === previousAddress) return
    mailRequestSeq += 1
    currentPage.value = 1
    totalCount.value = 0
    replaceCurrentMail(null)
    if (address) void fetchMails()
})

const onVisibilityChange = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    // 回到前台：立即补齐后台暂停期间可能积压的新邮件，并复位倒计时。
    if (isFirstPage.value) {
        currentAutoRefreshInterval.value = Number(configAutoRefreshInterval.value) || 10
        void refreshMails({ background: true })
    }
}

onMounted(async () => {
    await api.getSettings()
    simpleMounted = true
    await fetchMails()

    // 启动自动刷新
    timer.value = setInterval(async () => {
        // 隐藏标签页不轮询：省 D1 rows_read，也避免用户没在看时的无效请求。
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        if (!isFirstPage.value) {
            currentAutoRefreshInterval.value = Number(configAutoRefreshInterval.value) || 10
            return
        }

        if (--currentAutoRefreshInterval.value <= 0) {
            await refreshMails({ background: true })
        }
    }, 1000)

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange)
    }
})

onBeforeUnmount(() => {
    mailRequestSeq += 1;
    clearInterval(timer.value);
    if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    replaceCurrentMail(null);
})
</script>

<template>
    <div class="center">
        <div v-if="!settings.address">
            <n-card :bordered="false" embedded>
                <Login />
            </n-card>
        </div>

        <div v-else>
            <n-card :bordered="false" embedded>
                <div style="text-align: center; margin-bottom: 16px; font-size: 18px;">
                    <AddressSelect :showCopy="false" size="small" />
                </div>
                <n-flex justify="center">
                    <n-button @click="refreshMails()" :loading="loading" type="primary" tertiary size="small">
                        <template #icon>
                            <n-icon>
                                <RefreshFilled />
                            </n-icon>
                        </template>
                        {{ t('refreshMails') }}
                    </n-button>
                    <n-button @click="copyAddress" tertiary size="small">
                        <template #icon>
                            <n-icon>
                                <ContentCopyFilled />
                            </n-icon>
                        </template>
                        {{ t('copyAddress') }}
                    </n-button>
                    <n-button @click="useSimpleIndex = false" tertiary size="small">
                        <template #icon>
                            <n-icon>
                                <ExitToAppFilled />
                            </n-icon>
                        </template>
                        {{ t('exitSimpleIndex') }}
                    </n-button>
                    <n-button @click="showAccountSettingsCard = true" tertiary size="small">
                        <template #icon>
                            <n-icon>
                                <SettingsFilled />
                            </n-icon>
                        </template>
                        {{ t('accountSettings') }}
                    </n-button>
                </n-flex>
                <div v-if="isFirstPage" style="text-align: center; margin-top: 12px;">
                    <n-text depth="3" size="12">
                        {{ t('refreshAfter', { msg: Math.max(0, currentAutoRefreshInterval) }) }}
                    </n-text>
                </div>
            </n-card>

            <!-- 账户设置卡片 -->
            <n-card v-if="showAccountSettingsCard" :bordered="false" embedded closable
                @close="showAccountSettingsCard = false" :title="t('accountSettings')">
                <AccountSettings />
            </n-card>

            <n-card v-else :bordered="false" embedded style="text-align: left;">

                <div v-if="totalCount > 1">
                    <n-flex justify="space-between">
                        <n-button @click="prevPage" :disabled="!canGoPrev" text size="small">
                            <template #icon>
                                <n-icon>
                                    <ArrowBackIosNewFilled />
                                </n-icon>
                            </template>
                            {{ t('prevPage') }}
                        </n-button>
                        <n-text size="small">
                            {{ t('mailCount', { current: currentPageDisplay, total: totalCount }) }}
                        </n-text>
                        <n-button @click="nextPage" :disabled="!canGoNext" text size="small" icon-placement="right">
                            <template #icon>
                                <n-icon>
                                    <ArrowForwardIosFilled />
                                </n-icon>
                            </template>
                            {{ t('nextPage') }}
                        </n-button>
                    </n-flex>
                </div>

                <div v-if="!currentMail" class="no-mail">
                    <n-empty :description="t('noMails')" />
                </div>
                <div v-else>
                    <h3 v-if="currentMail.subject">{{ currentMail.subject }}</h3>
                    <div style="margin-top: 16px;">
                        <MailContentRenderer :mail="currentMail" :showEMailTo="false" :showReply="false"
                            :enableUserDeleteEmail="openSettings.enableUserDeleteEmail" :showSaveS3="false"
                            :onDelete="deleteMail" />
                    </div>
                </div>
            </n-card>
        </div>
        <n-modal v-model:show="showAddressCredential" preset="dialog" :title="t('addressCredential')">
            <span>
                <p>{{ t("addressCredentialTip") }}</p>
            </span>
            <n-card embedded>
                <b>{{ jwt }}</b>
            </n-card>
        </n-modal>
    </div>
</template>

<style scoped>
.center {
    max-width: 800px;
    margin: 0 auto;
}

.n-card {
    margin-top: 20px;
    width: 100%;
}
</style>
