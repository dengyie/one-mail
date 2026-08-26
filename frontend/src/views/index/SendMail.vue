<script setup>
import { useMessage } from 'naive-ui'
import '@wangeditor/editor/dist/css/style.css'
import { Editor, Toolbar } from '@wangeditor/editor-for-vue'
import { useScopedI18n } from '@/i18n/app'
import { computed, onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import AdminContact from '../common/AdminContact.vue'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { sanitizeHtml } from '../../utils/sanitize-html'

const message = useMessage()
const isPreview = ref(false)
const editorRef = shallowRef()
const sending = ref(false)

// 富文本/HTML 预览一律先消毒再 v-html（自伤防护）：编辑器内容可含外部粘贴
// 的 HTML（如 "回信时引用原始邮件"），javascript:/data:text/html/form-action
// 与事件属性在此层剥除。后端 send_mail 按 is_html=content 原样发出，故本层
// 是发送前唯一的富文本防线；仍建议仅对自己的可见内容开启正文加载。
const safePreviewContent = computed(() => sanitizeHtml(sendMailModel.value?.content || ''))

const { settings, sendMailModel, indexTab, userSettings } = useGlobalState()

const { t } = useScopedI18n('views.index.SendMail')

const contentTypes = [
    { label: t('text'), value: 'text' },
    { label: t('html'), value: 'html' },
    { label: t('rich text'), value: 'rich' },
]

const normalizeSendMailText = (content) => {
    return content
        .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

const hasSendMailContent = (content, contentType) => {
    if (typeof content !== 'string' || !content) {
        return false
    }

    if (contentType === 'text') {
        return normalizeSendMailText(content).length > 0
    }

    const container = document.createElement('div')
    container.innerHTML = content
    container.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove())

    const plainContent = normalizeSendMailText(container.textContent ?? '')
    if (plainContent.length > 0) {
        return true
    }

    return Boolean(container.querySelector('img, audio, video, iframe, svg, canvas, table'))
}

const send = async () => {
    if (sending.value) {
        return
    }

    const subject = `${sendMailModel.value.subject ?? ''}`.trim()
    const toMail = `${sendMailModel.value.toMail ?? ''}`.trim()
    const content = `${sendMailModel.value.content ?? ''}`

    if (!subject) {
        message.error(t('subjectEmpty'))
        return
    }
    if (!toMail) {
        message.error(t('toMailEmpty'))
        return
    }
    if (!hasSendMailContent(content, sendMailModel.value.contentType)) {
        message.error(t('contentEmpty'))
        return
    }

    const payload = {
        from_name: sendMailModel.value.fromName,
        to_name: sendMailModel.value.toName,
        to_mail: toMail,
        subject,
        is_html: sendMailModel.value.contentType != 'text',
        content,
    }

    sending.value = true
    try {
        await api.fetch(`/api/send_mail`,
            {
                method: 'POST',
                body: JSON.stringify(payload)
            })
        sendMailModel.value = {
            fromName: "",
            toName: "",
            toMail: "",
            subject: "",
            contentType: 'text',
            content: "",
        }
        isPreview.value = false
        message.success(t("successSend"));
        indexTab.value = 'sendbox'
    } catch (error) {
        message.error(error.message || "error");
    } finally {
        sending.value = false
    }
}

const requestAccess = async () => {
    try {
        await api.fetch(`/api/request_send_mail_access`,
            {
                method: 'POST',
                body: JSON.stringify({})
            }
        )
        message.success(t("success"))
        await api.getSettings();
    } catch (error) {
        message.error(error.message || "error");
    }
}

const toolbarConfig = {
    excludeKeys: ["uploadVideo"]
}

const editorConfig = {
    MENU_CONF: {
        'uploadImage': {
            async customUpload() {
                message.error(t('tooLarge'))
            },
            maxFileSize: 1 * 1024 * 1024,
            base64LimitSize: 1 * 1024 * 1024,
        }
    }
}

onBeforeUnmount(() => {
    const editor = editorRef.value
    if (editor == null) return
    editor.destroy()
})

const handleCreated = (editor) => {
    editorRef.value = editor;
}

onMounted(async () => {
    // make sure user_id is fetched
    if (!userSettings.value.user_id) await api.getUserSettings(message);
    await api.getSettings();
})
</script>

<template>
    <div class="w-full max-w-4xl mx-auto space-y-4" v-if="settings.address">
        <div class="flex items-center justify-between pb-2 border-b border-slate-200/80 dark:border-slate-800/80">
            <div>
                <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">编写并发送邮件</h2>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">使用当前临时地址或专属绑定发件渠道外发邮件</p>
            </div>
        </div>

        <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm">
            <div v-if="!settings.send_balance || settings.send_balance <= 0">
                <n-alert type="warning" :show-icon="false" :bordered="false" class="rounded-2xl">
                    {{ t('requestAccessTip') }}
                    <n-button type="primary" tertiary @click="requestAccess" size="small" class="ml-2">{{ t('requestAccess')
                        }}</n-button>
                </n-alert>
                <AdminContact />
            </div>
            <div v-else class="space-y-4">
                <div class="flex items-center justify-between p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-xs font-semibold text-blue-600 dark:text-blue-400">
                    <span>{{ t('send_balance') }}: {{ settings.send_balance }} 封可用额度</span>
                    <n-button type="primary" :loading="sending" :disabled="sending" @click="send" class="rounded-xl px-5">
                        {{ t('send') }}
                    </n-button>
                </div>
                
                <div class="space-y-4">
                    <n-form :model="sendMailModel">
                        <n-form-item :label="t('fromName')" label-placement="top">
                            <n-input-group>
                                <n-input v-model:value="sendMailModel.fromName" placeholder="发件人昵称" class="rounded-l-xl" />
                                <n-input :value="settings.address" disabled class="rounded-r-xl bg-slate-100 dark:bg-slate-800" />
                            </n-input-group>
                        </n-form-item>
                        <n-form-item :label="t('toName')" label-placement="top">
                            <n-input-group>
                                <n-input v-model:value="sendMailModel.toName" placeholder="收件人称呼" class="rounded-l-xl w-1/3" />
                                <n-input v-model:value="sendMailModel.toMail" placeholder="收件人电子邮箱 (name@example.com)" class="rounded-r-xl w-2/3" />
                            </n-input-group>
                        </n-form-item>
                        <n-form-item :label="t('subject')" label-placement="top">
                            <n-input v-model:value="sendMailModel.subject" placeholder="邮件主题..." class="rounded-xl" />
                        </n-form-item>
                        <n-form-item :label="t('options')" label-placement="top">
                            <div class="flex items-center gap-3">
                                <n-radio-group v-model:value="sendMailModel.contentType">
                                    <n-radio-button v-for="option in contentTypes" :key="option.value" :value="option.value"
                                        :label="option.label" />
                                </n-radio-group>
                                <n-button v-if="sendMailModel.contentType != 'text'" @click="isPreview = !isPreview" class="rounded-xl">
                                    {{ isPreview ? t('edit') : t('preview') }}
                                </n-button>
                            </div>
                        </n-form-item>
                        <n-form-item :label="t('content')" label-placement="top">
                            <n-card :bordered="false" embedded v-if="isPreview" class="rounded-2xl w-full">
                                <div v-html="safePreviewContent" />
                            </n-card>
                            <div v-else-if="sendMailModel.contentType == 'rich'" class="w-full border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden">
                                <Toolbar style="border-bottom: 1px solid #e2e8f0" :defaultConfig="toolbarConfig"
                                    :editor="editorRef" mode="default" />
                                <Editor style="height: 400px; overflow-y: hidden;" v-model="sendMailModel.content"
                                    :defaultConfig="editorConfig" mode="default" @onCreated="handleCreated" />
                            </div>
                            <n-input v-else type="textarea" v-model:value="sendMailModel.content" :autosize="{
                                minRows: 6
                            }" placeholder="输入邮件正文内容..." class="rounded-2xl" />
                        </n-form-item>
                    </n-form>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.n-card {
    max-width: 800px;
}

.n-button {
    text-align: left;
    margin-right: 10px;
}

.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
}

.left {
    text-align: left;
    place-items: left;
    justify-content: left;
}

.n-alert {
    margin-bottom: 10px;
}
</style>
