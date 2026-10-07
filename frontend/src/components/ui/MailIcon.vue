<script setup>
import UiIcon from '../ai/UiIcon.vue'
import {
  InboxOutlined, MailOutlineRound, EditOutlined, StarBorderRound,
  ManageAccountsOutlined, SettingsOutlined, MenuRound, LogOutRound,
  KeyRound, DashboardOutlined, BarChartOutlined, StorageOutlined,
  ShieldOutlined, AlternateEmailRound, ArchiveOutlined, MoreHorizRound,
  SendOutlined, PeopleOutlineRound, DnsOutlined, PaletteOutlined,
} from '@vicons/material'

defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: 20 } })

// awesome-ui is the first choice. Only missing mail-specific glyphs use the
// project's existing Material Icons package (Apache-2.0); no new dependency.
const mailIcons = {
  inbox: InboxOutlined, mail: MailOutlineRound, compose: EditOutlined,
  star: StarBorderRound, accounts: ManageAccountsOutlined, settings: SettingsOutlined,
  menu: MenuRound, logout: LogOutRound, key: KeyRound, dashboard: DashboardOutlined,
  chart: BarChartOutlined, database: StorageOutlined, shield: ShieldOutlined,
  address: AlternateEmailRound, archive: ArchiveOutlined, more: MoreHorizRound,
  send: SendOutlined, users: PeopleOutlineRound, domain: DnsOutlined, palette: PaletteOutlined,
}
</script>

<template>
  <component v-if="mailIcons[name]" :is="mailIcons[name]" :width="size" :height="size" class="mail-icon" aria-hidden="true" />
  <UiIcon v-else :name="name" :size="size" class="mail-icon" />
</template>
