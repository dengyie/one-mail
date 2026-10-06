<template>
  <div class="unified-inbox max-w-6xl mx-auto px-4 py-6 text-left space-y-4">
    <!-- 页头 -->
    <div class="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-200/80 dark:border-zinc-800/80">
      <div>
        <h1 class="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <span>📥</span>
          <span>{{ t('title') }}</span>
        </h1>
        <p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{{ t('subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <div class="flex flex-col items-end gap-0.5">
          <StatusIndicator :status="connStatus" :label="connLabel" />
          <span v-if="lastLoaded" class="text-[10px] text-zinc-400">{{ t('status.lastLoaded', { time: fmtTime(lastLoaded.getTime()) }) }}</span>
        </div>
        <n-switch v-model:value="autoRefresh" size="small" :round="false">
          <template #checked>
            {{ t('autoRefreshInterval') }}
          </template>
          <template #unchecked>
            {{ t('autoRefresh') }}
          </template>
        </n-switch>
        <n-button size="small" :loading="loading" @click="refreshList" quaternary circle>
          <template #icon><n-icon><RefreshRound /></n-icon></template>
        </n-button>
      </div>
    </div>

    <!-- 登录用户走用户 JWT；游客可使用兼容的 API-key 通道 -->
    <div
      v-if="!hasAccess"
      class="relative overflow-hidden rounded-3xl border border-blue-500/30 bg-gradient-to-br from-blue-50/90 via-indigo-50/50 to-cyan-50/60 dark:from-blue-950/50 dark:via-slate-900/90 dark:to-slate-950 p-6 sm:p-8 shadow-lg shadow-blue-500/5 backdrop-blur-2xl transition-all duration-300 hover:shadow-xl hover:shadow-blue-500/10 space-y-6"
    >
      <div class="absolute -right-16 -top-16 w-64 h-64 bg-gradient-to-br from-blue-500/10 via-indigo-500/10 to-transparent rounded-full blur-3xl pointer-events-none"></div>
      <div class="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div class="space-y-2.5 max-w-2xl">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 text-xs font-semibold tracking-wide border border-blue-500/20 shadow-xs">
            <span class="animate-pulse">✨</span>
            <span>{{ t('landing.badge') }}</span>
          </div>
          <h2 class="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {{ t('landing.heading') }}
          </h2>
          <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {{ t('auth.loginRequired') }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3 shrink-0">
          <n-button size="medium" type="primary" class="rounded-xl px-5 font-semibold shadow-md shadow-blue-500/25 transition-transform active:scale-95" @click="router.push(getRouterPathWithLang('/user', locale))">
            {{ t('auth.login') }}
          </n-button>
          <n-button size="medium" secondary class="rounded-xl px-4 font-medium transition-transform active:scale-95" @click="router.push(getRouterPathWithLang('/temp-mail', locale))">
            {{ t('landing.tempMail') }}
          </n-button>
          <n-button size="medium" ghost class="rounded-xl px-4 font-medium" @click="activeTab = 'settings'">
            {{ t('tabs.settings') }}
          </n-button>
        </div>
      </div>
    </div>
    <div
      v-else-if="!isLoggedIn && hasKey"
      class="rounded-2xl border border-sky-200 dark:border-sky-800/60 bg-sky-50/80 dark:bg-sky-950/30 text-sky-800 dark:text-sky-300 px-5 py-2.5 text-xs flex items-center justify-between gap-3 shadow-xs"
    >
      <div class="flex items-center gap-2">
        <span>🔑</span>
        <span>{{ t('auth.apiKeyMode') }}</span>
      </div>
      <n-button size="tiny" ghost @click="activeTab = 'settings'">管理 Key</n-button>
    </div>

    <n-tabs v-model:value="activeTab" type="segment" class="unified-tabs">
      <!-- ① 邮件列表 -->
      <n-tab-pane name="list" :tab="t('tabs.list')">
        <div class="space-y-4 pt-2">
          <!-- 快捷筛选 PromptChips -->
          <PromptChips :suggestions="quickFilterChips" @select="handleSelectChip" />

          <!-- 过滤 / 搜索 / 分页控制 -->
          <div class="flex flex-wrap items-center gap-2 bg-zinc-50/60 dark:bg-zinc-900/40 p-3 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">
            <n-input
              v-model:value="q"
              :placeholder="t('list.searchPlaceholder')"
              clearable
              size="small"
              style="max-width: 260px"
              @keyup.enter="applySearch"
            />
            <n-button size="small" type="primary" ghost @click="applySearch">
              <template #icon><n-icon><SearchRound /></n-icon></template>
              {{ t('list.search') }}
            </n-button>
            <n-select
              v-model:value="sourceFilter"
              :options="sourceOptions"
              clearable
              size="small"
              :placeholder="t('list.allSources')"
              style="width: 140px"
              @update:value="applyFilter"
            />
            <n-select
              v-model:value="accountFilter"
              :options="accountOptions"
              clearable
              size="small"
              :placeholder="t('list.allAccounts')"
              style="min-width: 180px; max-width: 260px"
              @update:value="applyFilter"
            />
            <n-checkbox v-model:checked="unreadOnly" @update:checked="applyFilter">
              {{ t('list.unread') }}
            </n-checkbox>
            <n-checkbox v-model:checked="starOnly" @update:checked="applyFilter">
              ⭐ 仅星标
            </n-checkbox>
            <div class="flex-1"></div>
            <span class="text-xs text-zinc-400 font-mono">{{ t('list.total', { count }) }}</span>
          </div>
          <div v-if="degradedShards.length" class="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{{ t('list.incompleteResults') }} ({{ degradedShards.join(', ') }})</span>
            <n-button text size="tiny" :loading="loading" @click="refreshList">{{ t('list.retryDegraded') }}</n-button>
          </div>
          <div v-if="optionsError" class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
            <span>{{ optionsError }}</span>
            <n-button text size="tiny" @click="retryOptions">重试</n-button>
          </div>

          <!-- 骨架屏：首屏与加载中时保持卡片高度与结构，避免视差抖动 -->
          <div
            v-if="loading && !emails.length"
            class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 divide-y divide-zinc-100 dark:divide-zinc-800/70 overflow-hidden bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl shadow-xs p-2 space-y-3"
          >
            <div v-for="i in 5" :key="i" class="px-4 py-3 flex items-center gap-3 animate-pulse">
              <div class="w-2.5 h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700 shrink-0"></div>
              <div class="w-8 h-8 rounded-xl bg-zinc-200 dark:bg-zinc-700 shrink-0"></div>
              <div class="flex-1 space-y-2">
                <div class="h-4 bg-zinc-200 dark:bg-zinc-700 rounded-md w-3/4"></div>
                <div class="h-3 bg-zinc-100 dark:bg-zinc-800 rounded-md w-1/3"></div>
              </div>
              <div class="w-16 h-3 bg-zinc-100 dark:bg-zinc-800 rounded-md shrink-0"></div>
            </div>
          </div>
          <div v-else-if="loading" class="py-20 text-center text-zinc-400 flex flex-col items-center gap-2">
            <span class="animate-spin text-xl">⏳</span>
            <span>{{ t('list.loading') }}</span>
          </div>
          <div v-else-if="listError" class="py-16 text-center text-sm text-rose-500">
            <div>{{ listError }}</div>
            <n-button size="small" class="mt-3" @click="loadList">重试</n-button>
          </div>
          <n-empty
            v-else-if="!emails.length"
            :description="filterActive ? t('list.emptyFiltered') : t('list.empty')"
            class="py-20"
          />
          <div
            v-else
            class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 divide-y divide-zinc-100 dark:divide-zinc-800/70 overflow-hidden bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl shadow-xs"
          >
            <div
              v-for="row in emails"
              :key="row.id"
              role="button"
              tabindex="0"
              class="group relative w-full text-left px-4 sm:px-5 py-3.5 flex items-center gap-3 sm:gap-4 hover:bg-blue-50/40 dark:hover:bg-slate-800/50 transition-all duration-150 cursor-pointer"
              @click="openDetail(row.id)"
              @keydown.enter.self="openDetail(row.id)"
            >
              <!-- 状态圆点 & 头像标识 -->
              <div class="flex items-center gap-2.5 shrink-0">
                <span
                  class="w-2.5 h-2.5 rounded-full shrink-0 transition-all"
                  :class="row.is_read ? 'bg-transparent border border-zinc-300 dark:border-zinc-700' : 'bg-emerald-500 shadow-xs shadow-emerald-500/60 ring-2 ring-emerald-500/20'"
                ></span>
                <div
                  class="w-8 h-8 rounded-xl bg-gradient-to-br flex items-center justify-center text-xs font-bold border shadow-2xs shrink-0 select-none"
                  :class="getSenderColorClass(row.from_addr)"
                >
                  {{ getSenderInitial(row.from_addr) }}
                </div>
              </div>

              <!-- 主题与元信息 -->
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span
                    v-if="row.is_starred"
                    class="text-amber-400 text-xs shrink-0 select-none"
                    title="已星标（受保护，不会被自动清理正文）"
                  >⭐</span>
                  <span
                    class="text-sm truncate transition-colors"
                    :class="row.is_read ? 'text-zinc-700 dark:text-zinc-300 font-normal' : 'text-zinc-950 dark:text-zinc-50 font-semibold'"
                  >
                    {{ row.subject || t('list.noSubject') }}
                  </span>
                  <!-- 就地提取高亮验证码胶囊 -->
                  <span
                    v-if="extractCardCode(row.subject)"
                    @click.stop="copyQuickCode(extractCardCode(row.subject))"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-mono text-[11px] font-bold border border-emerald-500/30 transition-all cursor-pointer shadow-2xs"
                    title="点击快捷复制验证码"
                  >
                    <span>⚡</span>
                    <span>{{ extractCardCode(row.subject) }}</span>
                    <span class="text-[9px] opacity-75">复制</span>
                  </span>
                  <n-tag size="tiny" :bordered="false" type="info" class="shrink-0 font-mono text-[11px] rounded-md">{{ row.source }}</n-tag>
                  <n-tag v-if="row.account_id" size="tiny" :bordered="false" class="shrink-0 font-mono text-[11px] rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">{{ row.account_id }}</n-tag>
                </div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-2">
                  <span class="font-medium text-zinc-600 dark:text-zinc-300">{{ row.from_addr }}</span>
                  <span v-if="row.account_id" class="text-zinc-400">→ {{ row.account_id }}</span>
                </div>
              </div>

              <!-- 右侧快捷操作与时间 -->
              <div class="flex items-center gap-2 shrink-0">
                <div class="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                  <button
                    type="button"
                    class="p-1.5 rounded-lg text-xs text-zinc-400 hover:text-amber-500 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    :title="row.is_starred ? '取消星标' : '设为星标'"
                    @click.stop="toggleRowStar(row)"
                  >
                    {{ row.is_starred ? '★' : '☆' }}
                  </button>
                  <button
                    type="button"
                    class="p-1.5 rounded-lg text-xs text-zinc-400 hover:text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    :title="row.is_read ? '标为未读' : '标为已读'"
                    @click.stop="toggleRowRead(row)"
                  >
                    {{ row.is_read ? '✉️' : '✓' }}
                  </button>
                </div>
                <div class="text-xs text-zinc-400 shrink-0 font-mono">{{ fmtTime(row.received_at) }}</div>
              </div>
            </div>
          </div>

          <n-pagination
            v-if="count > PAGE_SIZE"
            :page="page"
            :page-count="Math.ceil(count / PAGE_SIZE)"
            :page-size="PAGE_SIZE"
            @update:page="setPage"
            class="justify-center pt-2"
          />
        </div>
      </n-tab-pane>

      <!-- ② 验证码聚合视图 -->
      <n-tab-pane name="codes" :tab="t('tabs.codes')">
        <div class="space-y-4 pt-2">
          <div class="flex flex-wrap items-end gap-3 bg-zinc-50/60 dark:bg-zinc-900/40 p-4 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('codes.addrLabel') }}</span>
              <n-input
                v-model:value="codesAddr"
                size="small"
                :placeholder="t('codes.addrPlaceholder')"
                clearable
                style="width: 260px"
                @keyup.enter="loadCodes"
                @clear="loadCodes"
              />
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('list.fresh') }}</span>
              <n-select v-model:value="codesFresh" size="small" :options="freshOptions" style="width: 120px" />
            </div>
            <n-button type="primary" size="small" ghost :loading="codesLoading" @click="loadCodes">
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div v-if="codesError && !codes.length" class="text-sm text-rose-500 py-12 text-center">
            {{ codesError }}
          </div>
          <n-empty
            v-else-if="!codesLoading && !codes.length"
            :description="t('codes.empty')"
            class="py-16"
          />
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <div
              v-for="(c, i) in codes"
              :key="i"
              class="group relative rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 flex items-start justify-between gap-4 shadow-xs hover:shadow-md hover:border-emerald-500/40 transition-all duration-200"
            >
              <div class="min-w-0 space-y-1.5 flex-1">
                <div class="flex items-center gap-2">
                  <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <div class="font-mono text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 tracking-wider break-all select-all">
                    {{ c.code }}
                  </div>
                </div>
                <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {{ c.subject || t('list.noSubject') }}
                </div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-1.5">
                  <span v-if="c.to_addr">{{ c.from_addr }} → {{ c.to_addr }}</span>
                  <span v-else>{{ c.from_addr }}</span>
                  <span>·</span>
                  <span class="font-mono">{{ fmtTime(c.received_at) }}</span>
                </div>
              </div>
              <button
                type="button"
                @click="copyCode(i, c.code)"
                class="px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all duration-150 cursor-pointer shrink-0 shadow-2xs flex items-center gap-1.5 active:scale-95"
                :class="copiedIndex === i
                  ? 'bg-emerald-500 text-white border-emerald-600 shadow-emerald-500/30'
                  : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-500/30'"
              >
                <span>{{ copiedIndex === i ? '✓' : '📋' }}</span>
                <span>{{ copiedIndex === i ? t('codes.copied') : t('codes.copy') }}</span>
              </button>
            </div>
          </div>
        </div>
      </n-tab-pane>

      <!-- ③ 聚合器运行状态 -->
      <n-tab-pane name="status" :tab="t('tabs.status')">
        <div class="space-y-4 pt-2">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-xs text-zinc-500 dark:text-zinc-400 max-w-2xl">{{ t('status.mode') }}</p>
            <n-button size="small" :loading="statusLoading" @click="loadStatus">
              <template #icon><n-icon><RefreshRound /></n-icon></template>
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-blue-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">✉️</span>
                <span>{{ t('status.emails') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.emails }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-emerald-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">📬</span>
                <span>{{ t('status.unread') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-emerald-600 dark:text-emerald-400 mt-2 font-mono tracking-tight">{{ status.unread }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-purple-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">🌐</span>
                <span>{{ t('status.sources') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.sources.length }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-amber-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">👥</span>
                <span>{{ t('status.accounts') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.accounts.length }}</div>
            </div>
          </div>

          <div
            v-if="status.sources.length"
            class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs space-y-2"
          >
            <div class="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{{ t('status.sources') }}</div>
            <div class="flex flex-wrap gap-2">
              <n-tag v-for="s in status.sources" :key="s" size="small" :bordered="false">{{ s }}</n-tag>
            </div>
          </div>

          <div v-if="statusError" class="text-sm text-rose-500 py-4">
            {{ statusError }}
          </div>
          <div v-if="lastRefresh" class="text-xs text-zinc-400 font-mono">
            {{ t('status.lastRefresh', { time: fmtTime(lastRefresh.getTime()) }) }}
          </div>
        </div>
      </n-tab-pane>

      <!-- ④ API-key 设置 -->
      <n-tab-pane name="settings" :tab="t('tabs.settings')">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 pt-2">
          <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 space-y-3 shadow-xs">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
              <span>🔑</span>
              <span>{{ t('settings.title') }}</span>
            </h3>
            <p class="text-xs text-zinc-500">{{ t('settings.keyTip') }}</p>
            <n-input
              v-model:value="keyInput"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.keyPlaceholder')"
            />
            <div class="flex gap-2 pt-1">
              <n-button type="primary" size="small" @click="saveKey">{{ t('settings.save') }}</n-button>
              <n-button size="small" :loading="testing" @click="testKey">{{ t('settings.test') }}</n-button>
            </div>
          </div>

          <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 space-y-3 shadow-xs">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
              <span>✨</span>
              <span>{{ t('settings.createKey') }}</span>
            </h3>
            <p class="text-xs text-zinc-500">{{ t('settings.createKeyTip') }}</p>
            <n-input v-model:value="newKeyName" size="small" :placeholder="t('settings.keyNamePlaceholder')" />
            <n-select v-model:value="newKeyRole" size="small" :options="roleOptions" />
            <n-input
              v-model:value="newKeyAdminPassword"
              size="small"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.adminPasswordPlaceholder')"
            />
            <n-button
              type="primary"
              size="small"
              :loading="creating"
              :disabled="!newKeyName.trim() || !newKeyAdminPassword"
              @click="createKey"
            >
              {{ t('settings.create') }}
            </n-button>
            <div
              v-if="newKeyPlain"
              class="rounded-xl bg-zinc-900 dark:bg-zinc-800 text-emerald-400 font-mono text-xs p-3 break-all select-all shadow-inner"
            >
              {{ newKeyPlain }}
            </div>
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SearchRound, RefreshRound } from '@vicons/material'
import { useScopedI18n } from '../i18n/app'
import { api } from '../api'
import { useGlobalState, MIN_AUTO_REFRESH_INTERVAL } from '../store'
import StatusIndicator from '../components/ai/StatusIndicator.vue'
import PromptChips from '../components/ai/PromptChips.vue'
import { useMessage } from 'naive-ui'
import { getRouterPathWithLang } from '../utils'

const { locale, t } = useScopedI18n('unified')
const { unifiedApiKey, adminAuth, userJwt, userSettings, configAutoRefreshInterval } = useGlobalState()
const router = useRouter()
const route = useRoute()
const message = useMessage()

const isLoggedIn = computed(() => !!userJwt.value?.trim())
const hasKey = computed(() => !!unifiedApiKey.value?.trim())
const hasAdmin = computed(() => !!adminAuth.value?.trim())
const hasAccess = computed(() => isLoggedIn.value || hasKey.value || hasAdmin.value)

// Quick filter chips
const quickFilterChips = ['📬 全部邮件', '⭐ 星标邮件', '🟢 仅未读', '🔑 提取验证码', '🔄 刷新列表']

const handleSelectChip = (chip) => {
  if (chip.includes('全部邮件')) {
    unreadOnly.value = false
    starOnly.value = false
    sourceFilter.value = null
    accountFilter.value = null
    q.value = ''
    applyFilter()
  } else if (chip.includes('星标邮件')) {
    starOnly.value = true
    applyFilter()
  } else if (chip.includes('仅未读')) {
    unreadOnly.value = true
    applyFilter()
  } else if (chip.includes('提取验证码')) {
    activeTab.value = 'codes'
  } else if (chip.includes('刷新列表')) {
    refreshList()
  }
}

// ---- 顶部连接状态徽标 ----
const connected = ref(false)
const connStatus = computed(() => {
  if (!hasAccess.value) return 'offline'
  if (connected.value) return 'online'
  return 'connecting'
})
const connLabel = computed(() => {
  if (!hasAccess.value) return t('status.offline')
  if (connected.value) return t('status.online')
  return t('status.connecting')
})

const activeTab = ref('list')

// ---- 邮件列表 ----
const PAGE_SIZE = 20
// 刷新频率上限：跟随全局设置，但不允许高于 MIN_AUTO_REFRESH_INTERVAL 的频率。
// 历史版本曾硬编码 5s 轮询，每次都附带 COUNT(*) 全表扫描，会烧穿 D1 rows_read 免费额度。
const refreshIntervalMs = computed(() => (
  Math.max(MIN_AUTO_REFRESH_INTERVAL, Number(configAutoRefreshInterval.value) || MIN_AUTO_REFRESH_INTERVAL) * 1000
))
const emails = ref([])
const count = ref(0)
const loading = ref(false)
const listError = ref('')
const degradedShards = ref([])
const page = ref(1)
const q = ref('')
const sourceFilter = ref(null)
const accountFilter = ref(null)
const unreadOnly = ref(false)
const starOnly = ref(false)

const filterParams = computed(() => {
  const p = {
    source: sourceFilter.value || undefined,
    unread: unreadOnly.value ? 1 : undefined,
    starred: starOnly.value ? 1 : undefined,
    q: q.value.trim() || undefined,
  }
  if (accountFilter.value) {
    if (accountFilter.value.includes('@')) {
      p.to_addr = accountFilter.value
    } else {
      p.account_id = accountFilter.value
    }
  }
  return p
})
const listParams = computed(() => ({
  ...filterParams.value,
  limit: PAGE_SIZE,
  offset: (page.value - 1) * PAGE_SIZE,
}))
const filterActive = computed(() => !!(
  filterParams.value.source ||
  filterParams.value.account_id ||
  filterParams.value.to_addr ||
  filterParams.value.unread ||
  filterParams.value.starred ||
  filterParams.value.q
))

let listRequestSeq = 0
let codesRequestSeq = 0
let statusRequestSeq = 0
let backgroundListPending = false
let backgroundCodesPending = false

// 增量探测基线：最新一封邮件的 (received_at, id) 指纹。轮询先做 1 行探测，
// 基线没变化就完全不拉列表、不跑 COUNT(*)，避免无谓的 D1 rows_read。
const emailSortKey = (row) => `${Number(row?.received_at) || 0}:${row?.id ?? ''}`
let newestSeenKey = ''
let autoRefreshTimer = null
let componentDisposed = false
const autoRefresh = ref(true)

const loadList = async ({ background = false } = {}) => {
  if (!hasAccess.value) return
  if (background && backgroundListPending) return
  const requestId = ++listRequestSeq
  const requestedPage = page.value
  const requestedParams = listParams.value

  if (background) {
    backgroundListPending = true
  } else {
    loading.value = true
    listError.value = ''
  }

  try {
    const listRes = await api.unified.listEmails(requestedParams)
    if (requestId !== listRequestSeq) return
    emails.value = listRes.results || []
    // The first page already includes the scoped count; avoid a second full-table scan.
    if (requestedPage === 1 && typeof listRes.count === 'number') {
      count.value = listRes.count
    }
    // 刷新探测基线（仅第一页代表全域最新一封）
    if (requestedPage === 1 && emails.value.length > 0) {
      newestSeenKey = emailSortKey(emails.value[0])
    }
    degradedShards.value = Array.isArray(listRes.degraded) ? listRes.degraded : []
    listError.value = degradedShards.value.length
      ? '部分分片暂不可用，当前结果不完整'
      : ''
    connected.value = degradedShards.value.length === 0
    lastLoaded.value = new Date()
  } catch (e) {
    if (requestId !== listRequestSeq) return
    connected.value = false
    if (!background) {
      listError.value = e.message || 'error'
      degradedShards.value = []
      emails.value = []
      count.value = 0
    }
  } finally {
    if (background) {
      backgroundListPending = false
    } else if (requestId === listRequestSeq) {
      loading.value = false
    }
  }
}

const refreshList = () => loadList()
const applySearch = () => { page.value = 1; loadList() }
const applyFilter = () => { page.value = 1; loadList() }
const setPage = (p) => { page.value = p; loadList() }
const openDetail = (id) => router.push({
  path: getRouterPathWithLang(`/unified/${encodeURIComponent(id)}`, locale.value || locale),
  query: { from: route.fullPath },
})

// 辅助方法：发件人头像取字与渐变配色
const getSenderInitial = (addr) => {
  if (!addr) return '?'
  const clean = addr.replace(/<.*>/, '').replace(/[@._-]/g, ' ').trim()
  return (clean[0] || '?').toUpperCase()
}

const getSenderColorClass = (addr) => {
  const palettes = [
    'from-blue-500/20 to-indigo-500/30 text-blue-600 dark:text-blue-400 border-blue-500/30',
    'from-emerald-500/20 to-teal-500/30 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    'from-purple-500/20 to-pink-500/30 text-purple-600 dark:text-purple-400 border-purple-500/30',
    'from-amber-500/20 to-orange-500/30 text-amber-600 dark:text-amber-400 border-amber-500/30',
    'from-sky-500/20 to-cyan-500/30 text-sky-600 dark:text-sky-400 border-sky-500/30',
  ]
  if (!addr) return palettes[0]
  let hash = 0
  for (let i = 0; i < addr.length; i++) hash = (hash << 5) - hash + addr.charCodeAt(i)
  return palettes[(hash >>> 0) % palettes.length]
}

// 提取邮件主题中 4-8 位验证码（对齐后端 worker/src/unified/verifcode.ts 规则）
const extractCardCode = (subject) => {
  if (!subject) return ''
  // 1. 优先匹配 3+3 分隔格式（如 123-456 或 G-123456），排除电话号码
  const splitMatch = subject.match(/(?:code|验证码|verification|otp|pin|安全码|动态码|校验码|授权码|口令|passcode)[^\d]{0,24}(\b\d{3})[\s-](\d{3}\b)(?![\s-]?\d)/i)
  if (splitMatch) return splitMatch[1] + splitMatch[2]

  // 2. 匹配常见验证码前缀型（如 G-123456）
  const prefixMatch = subject.match(/\b([A-Z]-\d{4,8})\b/i)
  if (prefixMatch) return prefixMatch[1]

  // 3. 关键字邻近的 4-8 位验证码
  const kwMatch = subject.match(/(?:code|验证码|verification\s*code|otp|pin|安全码|动态码|校验码|授权码|口令|passcode|is|为)[:：\s]*([0-9]{4,8}|[A-Z0-9]{5,8})(?!\d|[-/.]\d{1,2}|年)/i)
  if (kwMatch && kwMatch[1]) return kwMatch[1]

  // 4. 独立 6 位纯数字退化匹配（严谨排除年份 19xx/20xx 与订单序号/金额前缀）
  const pureNum = subject.match(/(?<![#$¥€\d])\b(\d{6})\b(?!\d)/)
  if (pureNum && !/^(19|20)\d\d$/.test(pureNum[1]) && !/(?:order|订单|no|item|ref|ticket)/i.test(subject)) {
    return pureNum[1]
  }
  return ''
}

const copyQuickCode = async (code) => {
  try {
    await navigator.clipboard.writeText(code)
    message.success(`验证码 ${code} 已复制`)
  } catch (e) {
    message.error(t('codes.copyFailed'))
  }
}

// 乐观更新：即时修改列表视图状态，后台异步同步，失败时平滑回滚
const toggleRowStar = async (row) => {
  const previousStar = row.is_starred
  const targetStar = previousStar ? 0 : 1
  row.is_starred = targetStar
  try {
    await api.unified.toggleStar(row.id, targetStar)
    message.success(targetStar ? '已星标保护' : '已取消星标')
  } catch (e) {
    row.is_starred = previousStar
    message.error(e.message || '操作失败')
  }
}

const toggleRowRead = async (row) => {
  const previousRead = row.is_read
  const targetRead = !previousRead
  row.is_read = targetRead
  try {
    if (targetRead) {
      await api.unified.markRead(row.id)
    } else {
      await api.unified.markUnread(row.id)
    }
  } catch (e) {
    row.is_read = previousRead
    message.error(e.message || '操作失败')
  }
}

const probeNewestKey = async () => {
  // 探测请求只取 1 行，且 with_count=0 让 worker 跳过 COUNT(*) 全表扫描
  const probeRes = await api.unified.listEmails({ ...filterParams.value, limit: 1, offset: 0, with_count: 0 })
  const top = (probeRes.results || [])[0]
  return top ? emailSortKey(top) : ''
}

const autoRefreshList = () => {
  if (!autoRefresh.value || !hasAccess.value) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (activeTab.value !== 'list') {
    if (activeTab.value === 'codes' && !codesLoading.value && !backgroundCodesPending) {
      void loadCodes({ background: true })
    }
    return
  }
  if (loading.value || backgroundListPending) return
  void (async () => {
    let newestKey = ''
    try {
      newestKey = await probeNewestKey()
    } catch (e) {
      if (!backgroundListPending) connected.value = false
      return
    }
    const hasNew = newestKey !== newestSeenKey
    newestSeenKey = newestKey
    if (hasNew && !backgroundListPending) {
      await loadList({ background: true })
    }
  })()
}

const startAutoRefresh = () => {
  if (autoRefreshTimer != null || typeof window === 'undefined') return
  autoRefreshTimer = window.setInterval(autoRefreshList, refreshIntervalMs.value)
}

const stopAutoRefresh = () => {
  if (autoRefreshTimer == null || typeof window === 'undefined') return
  window.clearInterval(autoRefreshTimer)
  autoRefreshTimer = null
}

const handleVisibilityChange = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    autoRefreshList()
  }
}

// 来源/账号筛选项
const SOURCE_MAP = {
  imap_qq: 'QQ 邮箱',
  imap_gmail: 'Gmail',
  imap_163: '网易 163',
  imap_outlook: 'Outlook',
  cloudflare: 'Cloudflare',
  cf_routing: 'CF 邮件路由',
}

const userAccounts = ref([])
const boundAddresses = ref([])
const optionRows = ref([])

const sourceOptions = computed(() => {
  const set = new Set()
  userAccounts.value.forEach(a => { if (a.source) set.add(a.source) })
  optionRows.value.forEach(r => { if (r.source) set.add(r.source) })
  return [...set].map(s => ({
    label: SOURCE_MAP[s] ? `${SOURCE_MAP[s]} (${s})` : s,
    value: s,
  }))
})

const accountOptions = computed(() => {
  const list = []
  const seenValues = new Set()

  // 1. 用户配置的外部邮箱（最优先，显示 label + username）
  userAccounts.value.forEach(a => {
    const val = a.username || a.id
    if (val && !seenValues.has(val)) {
      seenValues.add(val)
      const label = a.label ? `${a.label} (${a.username})` : a.username
      list.push({ label, value: val })
    }
  })

  // 2. 绑定的本站域名邮箱
  boundAddresses.value.forEach(b => {
    const name = typeof b === 'string' ? b : b?.name
    if (name && !seenValues.has(name)) {
      seenValues.add(name)
      list.push({ label: `域名: ${name}`, value: name })
    }
  })

  // 3. 从邮件样本中发现的 account_id / to_addr（兜底兼容）
  optionRows.value.forEach(r => {
    const val = r.to_addr || r.account_id
    if (val && !seenValues.has(val)) {
      seenValues.add(val)
      list.push({ label: val, value: val })
    }
  })

  return list
})

const optionsError = ref('')
let optionsScope = ''
let optionsPromise = null
let optionsPromiseIdentity = ''
let optionsGeneration = 0

const authIdentity = computed(() => {
  const jwt = userJwt.value?.trim()
  if (jwt) return `user:${jwt}`
  const admin = adminAuth.value?.trim()
  if (admin) return `admin:${admin}`
  const key = unifiedApiKey.value?.trim()
  return key ? `key:${key}` : ''
})

const resetOptions = () => {
  optionsGeneration += 1
  optionsScope = ''
  optionsError.value = ''
  userAccounts.value = []
  boundAddresses.value = []
  optionRows.value = []
}

const loadOptions = async () => {
  const identity = authIdentity.value
  if (!identity) {
    resetOptions()
    return
  }
  if (optionsScope === identity && !optionsError.value) return
  if (optionsPromise && optionsPromiseIdentity === identity) return optionsPromise
  const generation = ++optionsGeneration
  optionsError.value = ''
  const promise = (async () => {
    const current = () => generation === optionsGeneration && identity === authIdentity.value
    const tasks = []
    if (isLoggedIn.value) {
      tasks.push(api.userMailAccounts.list().then(res => {
        if (current()) userAccounts.value = res.results || []
      }))
      tasks.push(api.fetch('/user_api/bind_address').then(res => {
        if (current()) boundAddresses.value = res.results || []
      }))
    }
    tasks.push(api.unified.meta().then(res => {
      if (!current()) return
      const rows = []
      ;(res.sources || []).forEach(source => rows.push({ source }))
      ;(res.accounts || []).forEach(account_id => rows.push({ account_id }))
      ;(res.to_addrs || []).forEach(to_addr => rows.push({ to_addr }))
      optionRows.value = rows
    }))
    const results = await Promise.allSettled(tasks)
    if (!current()) return
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('筛选项加载失败，请重试')
    }
    optionsScope = identity
  })()
  const handledPromise = promise.catch(error => {
    if (generation === optionsGeneration && identity === authIdentity.value) {
      optionsScope = ''
      optionsError.value = error.message || '筛选项加载失败，请重试'
    }
    return null
  })
  optionsPromise = handledPromise
  optionsPromiseIdentity = identity
  handledPromise.finally(() => {
    if (optionsPromise === handledPromise) {
      optionsPromise = null
      optionsPromiseIdentity = ''
    }
  })
  return handledPromise
}

const retryOptions = () => {
  optionsError.value = ''
  optionsScope = ''
  return loadOptions()
}

// ---- 验证码视图 ----
const codesAddr = ref('')
const codesFresh = ref(10)
const codes = ref([])
const codesLoading = ref(false)
const codesError = ref('')
const copiedIndex = ref(-1)
const freshOptions = [
  { label: '10 min', value: 10 },
  { label: '1 h', value: 60 },
  { label: '24 h', value: 1440 },
]

const loadCodes = async ({ background = false } = {}) => {
  if (background && backgroundCodesPending) return
  const requestId = ++codesRequestSeq
  const identity = authIdentity.value
  const isCurrent = () =>
    !componentDisposed && requestId === codesRequestSeq && identity === authIdentity.value && hasAccess.value
  if (!identity) {
    if (!background) codesLoading.value = false
    return
  }
  if (background) {
    backgroundCodesPending = true
  } else {
    codesLoading.value = true
    codesError.value = ''
  }
  try {
    const res = await api.unified.verifcodes(codesAddr.value.trim(), codesFresh.value * 60 * 1000)
    if (!isCurrent()) return
    codes.value = res.results || []
    connected.value = true
    codesError.value = ''
    lastLoaded.value = new Date()
  } catch (e) {
    if (!isCurrent()) return
    connected.value = false
    if (!background) {
      codesError.value = e.message || 'error'
      codes.value = []
    }
  } finally {
    if (background) {
      backgroundCodesPending = false
    }
    if (isCurrent() && !background) codesLoading.value = false
  }
}

const copyCode = async (index, code) => {
  try {
    await navigator.clipboard.writeText(code)
    copiedIndex.value = index
    setTimeout(() => { copiedIndex.value = -1 }, 1500)
  } catch (e) {
    message.error(t('codes.copyFailed'))
  }
}

// ---- 聚合器状态 ----
const status = ref({ emails: 0, unread: 0, sources: [], accounts: [] })
const statusLoading = ref(false)
const statusError = ref('')
const lastRefresh = ref(null)
// This records the last successful read from the unified API, not the last scheduled sync time.
const lastLoaded = ref(null)

const loadStatus = async () => {
  const requestId = ++statusRequestSeq
  const identity = authIdentity.value
  const isCurrent = () =>
    !componentDisposed && requestId === statusRequestSeq && identity === authIdentity.value && hasAccess.value
  if (!identity) {
    statusLoading.value = false
    return
  }
  statusLoading.value = true
  statusError.value = ''
  try {
    const stats = await api.unified.stats({})
    if (!isCurrent()) return
    if (!accountOptions.value.length && !sourceOptions.value.length) {
      await loadOptions()
      if (!isCurrent()) return
    }
    status.value = {
      emails: stats.count || 0,
      unread: stats.unread || 0,
      sources: sourceOptions.value.map(s => s.value),
      accounts: accountOptions.value.map(a => a.label || a.value),
    }
    lastRefresh.value = new Date()
    lastLoaded.value = lastRefresh.value
    connected.value = true
  } catch (e) {
    if (!isCurrent()) return
    statusError.value = e.message || 'error'
    connected.value = false
  } finally {
    if (isCurrent()) statusLoading.value = false
  }
}

// ---- API-key 设置 ----
const keyInput = ref(unifiedApiKey.value || '')
const testing = ref(false)
const newKeyName = ref('')
const newKeyRole = ref('readonly')
const newKeyAdminPassword = ref('')
const creating = ref(false)
const newKeyPlain = ref('')
const roleOptions = computed(() => [
  { label: t('settings.readonly'), value: 'readonly' },
  { label: t('settings.adminRole'), value: 'admin' },
])

const saveKey = () => {
  const v = keyInput.value.trim()
  if (!v) { message.error(t('settings.required')); return }
  unifiedApiKey.value = v
  message.success(t('settings.saved'))
}

const testKey = async () => {
  if (!unifiedApiKey.value.trim()) {
    message.error(t('settings.required'))
    return
  }
  testing.value = true
  try {
    await api.unified.count({})
    connected.value = true
    message.success(t('settings.testOk'))
  } catch (e) {
    connected.value = false
    message.error(`${t('settings.testFail')}: ${e.message}`)
  } finally {
    testing.value = false
  }
}

const createKey = async () => {
  creating.value = true
  const prevAdmin = adminAuth.value
  try {
    if (newKeyAdminPassword.value) adminAuth.value = newKeyAdminPassword.value
    const res = await api.admin.createUnifiedKey({
      name: newKeyName.value.trim(),
      role: newKeyRole.value,
    })
    newKeyPlain.value = res.key
    unifiedApiKey.value = res.key
    keyInput.value = res.key
    connected.value = true
    message.success(t('settings.created'))
  } catch (e) {
    message.error(e.message || 'error')
  } finally {
    adminAuth.value = prevAdmin
    creating.value = false
  }
}

// ---- 通用 ----
const fmtTime = (ms) => {
  if (!ms) return ''
  const d = new Date(Number(ms))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const refreshCurrent = () => {
  if (activeTab.value === 'list') loadList()
  else if (activeTab.value === 'codes') loadCodes()
  else if (activeTab.value === 'status') loadStatus()
}

watch(authIdentity, (identity, previousIdentity) => {
  if (identity === previousIdentity) return
  listRequestSeq += 1
  codesRequestSeq += 1
  statusRequestSeq += 1
  newestSeenKey = ''
  resetOptions()
  connected.value = false
  loading.value = false
  listError.value = ''
  codesAddr.value = ''
  codes.value = []
  codesError.value = ''
  codesLoading.value = false
  status.value = { emails: 0, unread: 0, sources: [], accounts: [] }
  statusError.value = ''
  statusLoading.value = false
  if (!identity) {
    emails.value = []
    count.value = 0
    return
  }
  void loadOptions()
  refreshCurrent()
})

watch(autoRefresh, (enabled) => {
  if (enabled) {
    startAutoRefresh()
  } else {
    stopAutoRefresh()
  }
})

// 设置里调整刷新间隔后，重排已挂载的定时器
watch(refreshIntervalMs, () => {
  if (autoRefreshTimer != null) {
    stopAutoRefresh()
    startAutoRefresh()
  }
})

watch(codesFresh, () => {
  if (activeTab.value === 'codes') {
    loadCodes()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'codes') {
    loadCodes()
  } else if (tab === 'status') {
    loadStatus()
  }
})

let isFirstMount = true

onMounted(async () => {
  componentDisposed = false
  if (userJwt.value && !userSettings.value.user_id) {
    await api.getUserSettings(message)
  }
  if (hasAccess.value) {
    await loadOptions()
    await loadList()
  }
  if (componentDisposed) return
  if (autoRefresh.value) {
    startAutoRefresh()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  isFirstMount = false
})

onActivated(() => {
  if (componentDisposed) return
  if (isFirstMount) return
  if (autoRefresh.value) {
    startAutoRefresh()
    autoRefreshList()
  }
})

onDeactivated(() => {
  stopAutoRefresh()
})

onBeforeUnmount(() => {
  componentDisposed = true
  backgroundListPending = false
  backgroundCodesPending = false
  listRequestSeq += 1
  codesRequestSeq += 1
  statusRequestSeq += 1
  stopAutoRefresh()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
})
</script>

<style scoped>
.unified-tabs {
  --n-bar-color: #18181b;
}
.dark .unified-tabs {
  --n-bar-color: #f4f4f5;
}
</style>
