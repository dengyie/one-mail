<script setup>
import { watch, onMounted, ref, computed } from "vue";
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../store'
import { useIsMobile } from '../utils/composables'
import { utcToLocalDate } from '../utils';
import { sanitizeHtml } from '../utils/sanitize-html';
import { SendRound } from '@vicons/material'

const message = useMessage()
const isMobile = useIsMobile()

const props = defineProps({
  enableUserDeleteEmail: {
    type: Boolean,
    default: false,
    required: false
  },
  showEMailFrom: {
    type: Boolean,
    default: false
  },
  fetchMailData: {
    type: Function,
    default: () => { },
    required: true
  },
  deleteMail: {
    type: Function,
    default: () => { },
    required: false
  },
  collapseOtp: {
    type: Boolean,
    default: false
  },
  emptyDescription: {
    type: String,
    default: ''
  },
  quietRefreshKey: {
    type: Number,
    default: 0
  },
})

const { isDark, mailboxSplitSize, loading, useUTCDate } = useGlobalState()
const data = ref([])
let refreshPending = false

const count = ref(0)
const page = ref(1)
const pageSize = ref(20)

const curMail = ref(null);
const showCode = ref(false)
const revealOtp = ref(false)

const SOURCE_TAG = {
  user_ui: { type: 'success', key: 'sourceUserUi' },
  user_api: { type: 'info', key: 'sourceUserApi' },
  external_api: { type: 'info', key: 'sourceExternalApi' },
  smtp_proxy: { type: 'warning', key: 'sourceSmtpProxy' },
  admin: { type: 'error', key: 'sourceAdmin' },
  admin_binding: { type: 'error', key: 'sourceAdminBinding' },
  system_otp: { type: 'warning', key: 'sourceSystemOtp' },
  unknown: { type: 'default', key: 'sourceUnknown' },
}

const CHANNEL_TAG = {
  resend: { type: 'success', key: 'channelResend' },
  smtp: { type: 'info', key: 'channelSmtp' },
  binding: { type: 'warning', key: 'channelBinding' },
  verified_binding: { type: 'warning', key: 'channelVerifiedBinding' },
}

const historyT = useScopedI18n('components.SendHistory').t

const sourceLabel = (row) => {
  const meta = SOURCE_TAG[row?.source] || SOURCE_TAG.unknown
  return { type: meta.type, text: historyT(meta.key) }
}

const channelLabel = (row) => {
  const meta = CHANNEL_TAG[row?.channel]
  return meta ? { type: meta.type, text: historyT(meta.key) } : null
}

const shouldHideOtp = (row) => props.collapseOtp && row?.source === 'system_otp' && !revealOtp.value

// 邮件正文为 HTML 时消毒后再渲染（与 MailContentRenderer/ShadowHtmlComponent 同一 sanitize 机制，防 XSS）
const safeContent = computed(() => sanitizeHtml(curMail.value?.content || ''))

const multiActionMode = ref(false)
const showMultiActionDelete = ref(false)
const multiActionDeleteProgress = ref({ percentage: 0, tip: '0/0' })

const { t } = useScopedI18n('components.SendBox')

watch([page, pageSize], async ([page, pageSize], [oldPage, oldPageSize]) => {
  if (page !== oldPage || pageSize !== oldPageSize) {
    await refresh();
  }
})

watch(() => props.quietRefreshKey, async (next, prev) => {
  if (next !== prev) {
    await refresh({ quiet: true });
  }
})

const refresh = async ({ quiet = false } = {}) => {
  if (refreshPending) return
  refreshPending = true
  try {
    const { results, count: totalCount } = await props.fetchMailData(
      pageSize.value, (page.value - 1) * pageSize.value
    );
    data.value = results.map((item) => {
      try {
        const data = JSON.parse(item.raw);
        item.source = item.source || data.source || 'unknown';
        item.channel = item.channel || data.channel || null;
        item.provider_message_id = item.provider_message_id || data.provider_message_id || null;
        if (data.version == "v2") {
          item.to_mail = item.to_mail || (data.to_name ? `${data.to_name} <${data.to_mail}>` : data.to_mail);
          item.subject = item.subject || data.subject;
          item.is_html = data.is_html;
          item.content = data.content;
          item.raw = JSON.stringify(data, null, 2);
        } else {
          item.to_mail = item.to_mail || data?.personalizations?.map(
            (p) => p.to?.map((t) => t.email).join(',')
          ).join(';');
          item.subject = item.subject || data.subject;
          item.is_html = (data.content[0]?.type != 'text/plain');
          item.content = data.content[0]?.value;
          item.raw = JSON.stringify(data, null, 2);
        }
      } catch (error) {
        console.log(error);
        item.source = item.source || 'unknown';
        item.provider_message_id = item.provider_message_id || null;
      }
      return item;
    });
    if (typeof totalCount === 'number' && page.value === 1) {
      count.value = totalCount;
    }
    if (!isMobile.value && !curMail.value && data.value.length > 0) {
      curMail.value = data.value[0];
    }
  } catch (error) {
    if (!quiet) {
      message.error(error.message || "error");
    }
    console.error(error);
  } finally {
    refreshPending = false
  }
};

const clickRow = async (row) => {
  curMail.value = row;
  revealOtp.value = false;
};

const mailItemClass = (row) => {
  return curMail.value && row.id == curMail.value.id ? (isDark.value ? 'overlay overlay-dark-backgroud' : 'overlay overlay-light-backgroud') : '';
};

const onSpiltSizeChange = (size) => {
  mailboxSplitSize.value = size;
}

const deleteMail = async () => {
  try {
    await props.deleteMail(curMail.value.id);
    message.success(t("success"));
    curMail.value = null;
    await refresh();
  } catch (error) {
    message.error(error.message || "error");
  }
};

const showMultiActionMode = computed(() => {
  return props.enableUserDeleteEmail;
});

const multiActionModeClick = (enableMulti) => {
  if (enableMulti) {
    data.value.forEach((item) => {
      item.checked = false;
    });
    multiActionMode.value = true;
  } else {
    multiActionMode.value = false;
    data.value.forEach((item) => {
      item.checked = false;
    });
  }
}

const multiActionSelectAll = (checked) => {
  data.value.forEach((item) => {
    item.checked = checked;
  });
}

const multiActionDeleteMail = async () => {
  try {
    loading.value = true;
    const selectedMails = data.value.filter((item) => item.checked);
    if (selectedMails.length === 0) {
      message.error(t('pleaseSelectMail'));
      return;
    }
    multiActionDeleteProgress.value = {
      percentage: 0,
      tip: `0/${selectedMails.length}`
    };
    for (const [index, mail] of selectedMails.entries()) {
      await props.deleteMail(mail.id);
      showMultiActionDelete.value = true;
      multiActionDeleteProgress.value = {
        percentage: Math.floor((index + 1) / selectedMails.length * 100),
        tip: `${index + 1}/${selectedMails.length}`
      };
    }
    message.success(t("success"));
    await refresh();
  } catch (error) {
    message.error(error.message || "error");
  } finally {
    loading.value = false;
    showMultiActionDelete.value = true;
  }
}

onMounted(async () => {
  await refresh();
});
</script>

<template>
  <div>
    <div v-if="!isMobile" class="left">
      <div style="margin-bottom: 10px;">
        <n-space v-if="multiActionMode">
          <n-button @click="multiActionModeClick(false)" tertiary>
            {{ t('cancelMultiAction') }}
          </n-button>
          <n-button @click="multiActionSelectAll(true)" tertiary>
            {{ t('selectAll') }}
          </n-button>
          <n-button @click="multiActionSelectAll(false)" tertiary>
            {{ t('unselectAll') }}
          </n-button>
          <n-popconfirm v-if="enableUserDeleteEmail" @positive-click="multiActionDeleteMail">
            <template #trigger>
              <n-button tertiary type="error">{{ t('delete') }}</n-button>
            </template>
            {{ t('deleteMailTip') }}
          </n-popconfirm>
        </n-space>
        <n-space v-else>
          <n-button v-if="showMultiActionMode" @click="multiActionModeClick(true)" type="primary" tertiary>
            {{ t('multiAction') }}
          </n-button>
          <div style="display: inline-block; margin-right: 10px;">
            <n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="count"
              :page-sizes="[20, 50, 100]" show-size-picker />
          </div>
          <n-button @click="refresh" type="primary" tertiary>
            {{ t('refresh') }}
          </n-button>
        </n-space>
      </div>
      <n-split direction="horizontal" :max="0.75" :min="0" :resize-trigger-size="8"
        :default-size="mailboxSplitSize" :on-update:size="onSpiltSizeChange">
        <template #resize-trigger>
          <div class="split-handle">
            <div class="split-handle__grip" />
          </div>
        </template>
        <template #1>
          <div style="overflow: auto; min-height: 60vh; max-height: 100vh;">
            <n-list hoverable clickable>
              <n-list-item v-for="row in data" v-bind:key="row.id" @click="() => clickRow(row)"
                :class="mailItemClass(row)">
                <template #prefix v-if="multiActionMode">
                  <n-checkbox v-model:checked="row.checked" />
                </template>
                <n-thing :title="row.subject">
                  <template #description>
                    <n-tag type="info">
                      ID: {{ row.id }}
                    </n-tag>
                    <n-tag type="info">
                      {{ utcToLocalDate(row.created_at, useUTCDate) }}
                    </n-tag>
                    <n-tag v-if="showEMailFrom" type="info">
                      FROM: {{ row.address }}
                    </n-tag>
                    <n-tag type="info">
                      TO: {{ row.to_mail }}
                    </n-tag>
                    <n-tag :type="sourceLabel(row).type">
                      {{ sourceLabel(row).text }}
                    </n-tag>
                    <n-tag v-if="channelLabel(row)" :type="channelLabel(row).type">
                      {{ channelLabel(row).text }}
                    </n-tag>
                    <n-tag v-if="row.provider_message_id" type="default">
                      {{ historyT('providerId') }}: {{ row.provider_message_id }}
                    </n-tag>
                  </template>
                </n-thing>
              </n-list-item>
            </n-list>
          </div>
        </template>
        <template #2>
          <n-card :bordered="false" embedded v-if="curMail" class="mail-item" :title="curMail.subject"
            style="overflow: auto; max-height: 100vh;">
            <n-space>
              <n-tag type="info">
                ID: {{ curMail.id }}
              </n-tag>
              <n-tag type="info">
                {{ utcToLocalDate(curMail.created_at, useUTCDate) }}
              </n-tag>
              <n-tag type="info">
                FROM: {{ curMail.address }}
              </n-tag>
              <n-tag type="info">
                TO: {{ curMail.to_mail }}
              </n-tag>
              <n-tag :type="sourceLabel(curMail).type">
                {{ sourceLabel(curMail).text }}
              </n-tag>
              <n-tag v-if="channelLabel(curMail)" :type="channelLabel(curMail).type">
                {{ channelLabel(curMail).text }}
              </n-tag>
              <n-tag v-if="curMail.provider_message_id" type="default">
                {{ historyT('providerId') }}: {{ curMail.provider_message_id }}
              </n-tag>
              <n-button size="small" tertiary type="info" @click="showCode = !showCode">
                {{ t('showCode') }}
              </n-button>
              <n-popconfirm v-if="enableUserDeleteEmail" @positive-click="deleteMail">
                <template #trigger>
                  <n-button tertiary type="error" size="small">{{ t('delete') }}</n-button>
                </template>
                {{ t('deleteMailTip') }}
              </n-popconfirm>
            </n-space>
            <div v-if="shouldHideOtp(curMail)" class="mt-3 space-y-2">
              <n-alert type="warning" :bordered="false">{{ historyT('otpCollapsed') }}</n-alert>
              <n-button size="small" tertiary @click="revealOtp = true">{{ historyT('revealOtp') }}</n-button>
            </div>
            <pre v-else-if="showCode" style="margin-top: 10px;">{{ curMail.raw }}</pre>
            <pre v-else-if="!curMail.is_html" style="margin-top: 10px;">{{ curMail.content }}</pre>
            <div v-else v-html="safeContent" style="margin-top: 10px;"></div>
          </n-card>
          <n-card :bordered="false" embedded class="mail-item" v-else>
            <n-result status="info" :title="count === 0 ? (emptyDescription || t('emptySent')) : t('pleaseSelectMail')">
              <template #icon>
                <n-icon :component="SendRound" :size="100" />
              </template>
            </n-result>
          </n-card>
        </template>
      </n-split>
    </div>
    <div class="left" v-else>
      <div class="center">
        <div style="display: inline-block; margin-right: 10px;">
          <n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="count" simple size="small" />
        </div>
        <n-button @click="refresh" size="small" type="primary">
          {{ t('refresh') }}
        </n-button>
      </div>
      <div style="overflow: auto; min-height: 60vh; max-height: 100vh;">
        <n-list hoverable clickable>
          <n-list-item v-for="row in data" v-bind:key="row.id" @click="() => clickRow(row)">
            <n-thing :title="row.subject">
              <template #description>
                <n-tag type="info">
                  ID: {{ row.id }}
                </n-tag>
                <n-tag type="info">
                  {{ utcToLocalDate(row.created_at, useUTCDate) }}
                </n-tag>
                <n-tag v-if="showEMailFrom" type="info">
                  FROM: {{ row.address }}
                </n-tag>
                <n-tag type="info">
                  TO: {{ row.to_mail }}
                </n-tag>
                <n-tag :type="sourceLabel(row).type">
                  {{ sourceLabel(row).text }}
                </n-tag>
                <n-tag v-if="channelLabel(row)" :type="channelLabel(row).type">
                  {{ channelLabel(row).text }}
                </n-tag>
                <n-tag v-if="row.provider_message_id" type="default">
                  {{ historyT('providerId') }}: {{ row.provider_message_id }}
                </n-tag>
              </template>
            </n-thing>
          </n-list-item>
        </n-list>
      </div>
      <n-drawer v-model:show="curMail" width="100%" placement="bottom" :trap-focus="false" :block-scroll="false"
        style="height: 80vh;">
        <n-drawer-content :title="curMail ? curMail.subject : ''" closable>
          <n-card :bordered="false" embedded style="overflow: auto;">
            <n-space>
              <n-tag type="info">
                ID: {{ curMail.id }}
              </n-tag>
              <n-tag type="info">
                {{ utcToLocalDate(curMail.created_at, useUTCDate) }}
              </n-tag>
              <n-tag type="info">
                FROM: {{ curMail.address }}
              </n-tag>
              <n-tag type="info">
                TO: {{ curMail.to_mail }}
              </n-tag>
              <n-tag :type="sourceLabel(curMail).type">
                {{ sourceLabel(curMail).text }}
              </n-tag>
              <n-tag v-if="channelLabel(curMail)" :type="channelLabel(curMail).type">
                {{ channelLabel(curMail).text }}
              </n-tag>
              <n-tag v-if="curMail.provider_message_id" type="default">
                {{ historyT('providerId') }}: {{ curMail.provider_message_id }}
              </n-tag>
              <n-button size="small" tertiary type="info" @click="showCode = !showCode">
                {{ t('showCode') }}
              </n-button>
              <n-popconfirm v-if="enableUserDeleteEmail" @positive-click="deleteMail">
                <template #trigger>
                  <n-button tertiary type="error" size="small">{{ t('delete') }}</n-button>
                </template>
                {{ t('deleteMailTip') }}
              </n-popconfirm>
            </n-space>
            <div v-if="shouldHideOtp(curMail)" class="mt-3 space-y-2">
              <n-alert type="warning" :bordered="false">{{ historyT('otpCollapsed') }}</n-alert>
              <n-button size="small" tertiary @click="revealOtp = true">{{ historyT('revealOtp') }}</n-button>
            </div>
            <pre v-else-if="showCode" style="margin-top: 10px;">{{ curMail.raw }}</pre>
            <pre v-else-if="!curMail.is_html" style="margin-top: 10px;">{{ curMail.content }}</pre>
            <div v-else v-html="safeContent" style="margin-top: 10px;"></div>
          </n-card>
        </n-drawer-content>
      </n-drawer>
    </div>
  </div>
</template>

<style scoped>
.left {
  text-align: left;
}

.center {
  text-align: center;
}

.overlay {
  width: 100%;
  height: 100%;
  z-index: 1000;
}

.overlay-dark-backgroud {
  background-color: rgba(255, 255, 255, 0.1);
}

.overlay-light-backgroud {
  background-color: rgba(0, 0, 0, 0.1);
}

.mail-item {
  height: 100%;
}

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}

.split-handle {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.split-handle__grip {
  width: 4px;
  height: 32px;
  border-radius: 2px;
  background-color: var(--n-resize-trigger-color);
  transition: background-color 0.2s;
}

.split-handle:hover .split-handle__grip {
  background-color: var(--n-resize-trigger-color-hover);
}
</style>
