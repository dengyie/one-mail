<script setup>
import { useRoute } from 'vue-router'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { computed, onMounted, onBeforeUnmount, watch, ref } from 'vue';
import { processItem, revokeProcessedItemUrls } from '../../utils/email-parser'
import { utcToLocalDate } from '../../utils';
import { sanitizeHtmlMail } from '../../utils/sanitize-html-mail';

const { telegramApp, loading, useUTCDate } = useGlobalState()
const route = useRoute()

const curMail = ref({});
let mailRequestSeq = 0;

const replaceCurrentMail = (nextMail) => {
    const previousMail = curMail.value;
    curMail.value = nextMail || {};
    if (previousMail && previousMail !== curMail.value) {
        revokeProcessedItemUrls(previousMail);
    }
};

const fetchMailData = async (requestId) => {
    if (requestId === mailRequestSeq) {
        loading.value = true;
    }
    try {
        const res = await api.fetch(`/telegram/get_mail`, {
            method: 'POST',
            body: JSON.stringify({
                initData: telegramApp.value.initData,
                mailId: route.query.mail_id
            })
        });
        const parsedMail = await processItem(res);
        if (requestId !== mailRequestSeq) {
            revokeProcessedItemUrls(parsedMail);
            return null;
        }
        return parsedMail;
    }
    catch (error) {
        console.error(error);
        return {};
    }
    finally {
        if (requestId === mailRequestSeq) {
            loading.value = false;
        }
    }
};

const loadMail = async () => {
    const requestId = ++mailRequestSeq;
    const nextMail = await fetchMailData(requestId);
    if (requestId !== mailRequestSeq || nextMail === null) return;
    replaceCurrentMail(nextMail);
};

watch(telegramApp, () => {
    if (telegramApp.value.initData) {
        void loadMail();
    }
});

onMounted(() => {
    void loadMail();
});

onBeforeUnmount(() => {
    mailRequestSeq += 1;
    revokeProcessedItemUrls(curMail.value);
});

// C2：与主邮件正文相同安全管道——srcdoc 只喂经 blockRemoteContent
// （provablyLocal + DOMPurify 白名单）消毒后的 HTML，绝不直铺原始 parse 输出。
const safeMailMessage = computed(() =>
    sanitizeHtmlMail(curMail.value.message).html
);
</script>

<template>
    <div class="center">
        <n-card :bordered="false" embedded v-if="curMail.message" style="max-width: 800px; height: 100%;">
            <n-tag type="info">
                ID: {{ curMail.id }}
            </n-tag>
            <n-tag type="info">
                Date: {{ utcToLocalDate(curMail.created_at, useUTCDate) }}
            </n-tag>
            <n-tag type="info">
                FROM: {{ curMail.source }}
            </n-tag>
            <n-tag v-if="showEMailTo" type="info">
                TO: {{ curMail.address }}
            </n-tag>
            <iframe
                :srcdoc="safeMailMessage"
                sandbox="allow-same-origin"
                style="margin-top: 10px;width: 100%; height: 100%;">
            </iframe>
        </n-card>
    </div>
</template>


<style scoped>
.center {
    display: flex;
    text-align: left;
    place-items: center;
    justify-content: center;
    height: 80vh;
}
</style>
