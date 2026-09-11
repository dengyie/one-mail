<script setup>
import { ref, onMounted, h } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { NInputNumber, NTag, NSpace, NButton, useMessage } from 'naive-ui';

import { useGlobalState } from '../../store'
import { api } from '../../api'

const { loading } = useGlobalState()
const message = useMessage()

const { t } = useScopedI18n('views.admin.RoleAddressConfig')
const finiteQuotaLabel = (key) => t(key).replace(/\s*[（(]0[^）)]*[）)]\s*$/u, '')

const systemRoles = ref([])
const tableData = ref([])

const fetchUserRoles = async () => {
    try {
        const results = await api.fetch(`/admin/user_roles`);
        systemRoles.value = results;
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const fetchRoleConfigs = async () => {
    try {
        const { configs } = await api.fetch(`/admin/role_address_config`);
        tableData.value = systemRoles.value.map(roleObj => ({
            role: roleObj.role,
            max_address_count: configs[roleObj.role]?.maxAddressCount ?? null,
            // 外部邮箱接入上限；空=用全局默认 5（getMaxMailAccountCount）
            max_mail_account_count: configs[roleObj.role]?.maxMailAccountCount ?? null,
        }));
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const saveConfig = async () => {
    try {
        // convert tableData to object with nested structure
        const configs = {};
        tableData.value.forEach(row => {
            // 只为显式配置过的角色写键，空值省略（后端缺失即回退默认）
            if (row.max_address_count !== null && row.max_address_count !== undefined
                || row.max_mail_account_count !== null && row.max_mail_account_count !== undefined) {
                const cfg = {};
                if (row.max_address_count !== null && row.max_address_count !== undefined) {
                    cfg.maxAddressCount = row.max_address_count;
                }
                if (row.max_mail_account_count !== null && row.max_mail_account_count !== undefined) {
                    cfg.maxMailAccountCount = row.max_mail_account_count;
                }
                configs[row.role] = cfg;
            }
        });

        await api.fetch(`/admin/role_address_config`, {
            method: 'POST',
            body: JSON.stringify({ configs })
        });
        message.success(t('successTip'));
        await fetchRoleConfigs();
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const columns = [
    {
        title: t('role'),
        key: 'role',
        width: 200,
        render(row) {
            return h(NTag, {
                type: 'info',
                bordered: false
            }, {
                default: () => row.role
            })
        }
    },
    {
        title: finiteQuotaLabel('maxAddressCount'),
        key: 'max_address_count',
        render(row) {
            return h(NInputNumber, {
                value: row.max_address_count,
                min: 1,
                max: 999,
                clearable: true,
                placeholder: t('notConfigured'),
                style: 'width: 200px;',
                onUpdateValue: (value) => {
                    row.max_address_count = value;
                }
            })
        }
    },
    {
        title: finiteQuotaLabel('maxMailAccountCount'),
        key: 'max_mail_account_count',
        render(row) {
            return h(NInputNumber, {
                value: row.max_mail_account_count,
                min: 1,
                max: 999,
                clearable: true,
                placeholder: t('notConfiguredMailAccount'),
                style: 'width: 200px;',
                onUpdateValue: (value) => {
                    row.max_mail_account_count = value;
                }
            })
        }
    }
]

onMounted(async () => {
    await fetchUserRoles();
    await fetchRoleConfigs();
})
</script>

<template>
    <div style="margin-top: 10px;">
        <n-alert v-if="systemRoles.length === 0" type="warning" :bordered="false">
            {{ t('noRolesAvailable') }}
        </n-alert>

        <div v-else>
            <n-space justify="end" style="margin-bottom: 12px;">
                <n-button :loading="loading" @click="saveConfig" type="primary">
                    {{ t('save') }}
                </n-button>
            </n-space>

            <n-data-table
                :columns="columns"
                :data="tableData"
                :bordered="false"
                embedded
            />
        </div>
    </div>
</template>

<style scoped>
.n-data-table {
    min-width: 600px;
}
</style>
