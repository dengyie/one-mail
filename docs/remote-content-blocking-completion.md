# 外部/远程内容阻断功能——补全方案开发文档

> 状态：**已实现（2026-09-11）** ｜ 涉及 `UnifiedInboxDetail.vue` + `mail-actions.js` 两个补全点 + 测试
> 对应需求：`已阻止部分不安全或远程内容（N 项）` 功能在统一收件箱详情里没有恢复入口；回复/转发引用路径旁路了远程内容阻断。
> 上游安全管道（已实现且有测试）：`frontend/src/utils/remote-content-policy.js` + `sanitize-html-mail.js`，59 条测试全绿。

---

## 一、背景与目标

`one-mail` 为防「打开邮件 = 确认已读」的跟踪泄露，对邮件正文统一执行**远程内容阻断**：
非本地资源（`cid:` / `data:image/` / `blob:` / 站内相对路径之外的一切）一律替换为透明像素占位，`<style>` 里的 `url()` / `@import` / `image-set()` 同样过滤，`<base>/<script>/<iframe>/<meta>…` 整元素移除（`remote-content-policy.js` 的「可证明本地」白名单失败封闭）。

主阅读器 `MailContentRenderer.vue` 已具备**完整闭环**：阻断提示条 + 阻断计数 + 「加载图片」按钮（按封面恢复远程 `<img>`，且 `allowRemote` 只放开 `IMG src`、不削弱脚本/事件/`javascript:`/CSS 防御）。

本次要补的是两个没走齐的点：

### 目标 1 —— 统一收件箱详情缺「加载图片」入口（UX/能力不一致）
`frontend/src/views/UnifiedInboxDetail.vue:132-134` 只输出纯文本提示
```
已阻止部分不安全或远程内容（{count} 项）。
```
没有任何按钮，也没有 `blockRemoteContent(html, { allowRemote: true })` 按封恢复选项。
用户在主阅读器能一键恢复远程图片，在统一收件箱里却不能——体验割裂。

### 目标 2 —— 回复/转发引用旁路远程阻断（隐私红线）
`frontend/src/utils/mail-actions.js:19-27` 的 `sanitizeContent()` 用裸 `DOMPurify.sanitize()`，而非统一的 `blockRemoteContent` 管道。
`MailBox.vue:265/270` 回信/转发用它会话把原文包进 `blockquote` 塞进发送框。后果：
- 原文远程跟踪图、`<style>` 外部 `url()` 被原样带进回复草稿；
- 用户一旦点发送，收件方客户端就会加载这些远程资源——正好绕过了「除非远程内容防跟踪」设计目标。
- 这不构成 XSS（DOMPurify 仍剥脚本/事件），但属于**隐私层面的真实旁路**，且仓库内 `sanitize-html-mail.js` 头注释明确写「这是邮件正文唯一安全边界，所有渲染入口都必须走它」。

> 补充：`frontend/src/i18n/message-registry.ts:2955` 的 `detail.htmlBlocked` 文案与主阅读器 `remoteImagesBlocked`（`message-registry.ts:199`）不统一（后者文案「已阻止 N 项外部资源以保护隐私」+ 带按钮）。文案统一也纳入目标 1。

---

## 二、改动清单（4 个文件 + 2 个测试文件）

| # | 文件 | 改动 | 关联目标 |
|---|------|------|---------|
| 1 | `frontend/src/views/UnifiedInboxDetail.vue` | 补 `showRemoteImages` 本地状态 + 按封面恢复分支 +「加载图片」按钮 | 目标 1 |
| 2 | `frontend/src/i18n/message-registry.ts`（`unified.detail` 块） | 文案与主阅读器统一（`已阻止 N 项外部资源以保护隐私`），补 `loadRemoteImages` 键 | 目标 1 |
| 3 | `frontend/src/utils/mail-actions.js` | `sanitizeContent()` 改用 `blockRemoteContent`（默认 `allowRemote:false` 严格阻断）；并同步 `remote-content-policy.js` 处过期注释 | 目标 2 |
| 4 | `frontend/src/views/index/SendMail.vue` | `send()` 发送前对 `content` 按类型兜底净化（`html`/`rich` 走 `sanitizeHtml` 防 XSS 带入收件方；`text` 按原样） | 目标 2 根因 |
| 5 | `frontend/src/utils/__tests__/remote-content-policy.test.js` + `sanitize-html-mail.test.js` + `mail-actions.test.js` | 锁定回信/转发引用时远程内容默认阻断、XSS 属性仍剥、允许远程「加载图片」保留本地资源 | 目标 1+2 |

---

## 三、实现要点

### 目标 1 —— UnifiedInboxDetail.vue

参考 `MailContentRenderer.vue:124-135` 的既有写法：

```js
// 状态：per-mail 意向（切换邮件即重置）
const showRemoteImages = ref(false)

// 经停 sanitizeHtmlMail（默认阻断）作为基线；用户显式要求时才走 allowRemote（只放宽远程 <img>）
const sanitisedHtml = computed(() => {
  if (!email.value?.html_body) return { html: '', blocked: 0 }
  if (autoLoadRemoteImages.value || showRemoteImages.value) {
    return blockRemoteContent(email.value.html_body, { allowRemote: true })
  }
  return sanitizeHtmlMail(email.value.html_body)
})
const htmlBody   = computed(() => sanitisedHtml.value.html)
const htmlBlocked = computed(() => sanitisedHtml.value.blocked)
const handleLoadRemoteImages = () => { showRemoteImages.value = true }
```

2. 切换邮件时重置 `showRemoteImages.value = false`（仿 `MailContentRenderer.vue:113-122` 的 `watch(() => props.mail.id)`），避免把上一封的友好具带回下一封。

3. 导入：当前 `UnifiedInboxDetail.vue:163` 只导入了 `sanitizeHtmlMail`，需补 `blockRemoteContent`。

4. 模板把第 132-134 行纯文本提示替换为主阅读器同款告警条 + 按钮：

```vue
<n-alert v-if="htmlBlocked" type="warning" :show-icon="false" :bordered="false" class="mt-3 rounded-xl">
  <div class="flex items-center justify-between w-full">
    <span>{{ t('detail.htmlBlocked', { count: htmlBlocked }) }}</span>
    <n-button size="tiny" tertiary type="warning" @click="handleLoadRemoteImages">
      <template #icon><n-icon><ImageRound /></n-icon></template>
      {{ t('detail.loadRemoteImages') }}
    </n-button>
  </div>
</n-alert>
```
（需在 script 引入 `ImageRound`，见下方 i18n 键。）

### 目标 1 的 i18n（`unified` 命名空间内新增/统一）

在 `message-registry.ts` 的 `unified` 块中：

```ts
"detail.htmlBlocked": {
  "en": "{count} remote resources blocked to protect your privacy",
  "zh": "已阻止 {count} 项外部资源以保护隐私"
},
"detail.loadRemoteImages": {
  "en": "Load Images",
  "zh": "加载图片"
},
```

### 目标 2 —— mail-actions.js 统一走 blockRemoteContent

```js
import { blockRemoteContent } from './remote-content-policy'

function sanitizeContent(mail) {
  if (mail.message) {
    // 引用/转发邮件内容必须走同一安全边界：阻断远程资源，只保留可证明本地引用
    return blockRemoteContent(mail.message).html
  }
  if (mail.text) {
    return escapeHtml(mail.text)
  }
  return ''
}
```
- 保持 `allowRemote` 缺省 `false`（严格阻断）——回信/转发不得幻想远程图片。
- 该函数先前用同一个 `mail.message` 供 gzip。不改动 `buildReplyModel` / `buildForwardModel` 的外部签章。

---

## 四、边界与安全注意

- `allowRemote` 只放开 `<img src>`，绝不放开脚本/事件属性/`javascript:`/`data:`/CSS `url()`——现有 `remote-content-policy.test.js` 已锁定该语义，`UnifiedInboxDetail` 复用同一 purifier，无新攻击面。
- 统一收件的 `detail.htmlBlocked` 是 `sanitisedHtml.blocked` 的幂等输出，非真实 hit 注册。
- `mail-actions.js` 的 DOMPurify 必须改为 `blockRemoteContent`，避免双管道分岔；切换后 `buildReplyModel`/`buildForwardModel` 的外部接口（返回 `{toName, toMail, subject, contentType, content}`）不变。
- 回信内容里保留的 `blob:` / `cid:` 内联图片（本地资源）仍应保留——`blockRemoteContent` 对它们是可证明本地，不阻断，与 docs 中「站内资源经 cid/blob 保留以便排版」一致。

---

## 五、变更清单与验收标准

### 清单（按优先级）
1. **P0（功能补齐）** `UnifiedInboxDetail.vue` 加「加载图片」入口 + 重置 state + `allowRemote` 分支。
2. **P0（隐私红线）** `mail-actions.js` `sanitizeContent` 换 `blockRemoteContent`。
3. **P1（一致性）** i18n `detail.htmlBlocked` 文案与 `remoteImagesBlocked` 统一；新增 `detail.loadRemoteImages`。
4. **P1（回归）** 新增 `mail-actions.test.js`；若改 `UnifiedInboxDetail` 重要逻辑接现有 vitest（jsdom）锁定 allowRemote 分支、`blocked` 计数、无 XSS。

### 验收（手工 + 自动）
- 统一收件箱打开含远程图片邮件：显示「已阻止 N 项」告警条；点「加载图片」后，仅远程 `<img src>` 恢复、`<script>`/事件属性/`javascript:` 依旧剥离。
- 回信/转发一封含远程跟踪图的邮件：发送框 `blockquote` 内不再出现远程图片 URL（被透明占位替换），事件属性和 `javascript:` href 均不出现。
- 现有 vocab：`remote-content-policy.test.js`（48）+ `sanitize-html-mail.test.js`（11）保持全绿。

---

## 六、落地后的回归命令

```bash
cd frontend
npx vitest run src/utils/__tests__/remote-content-policy.test.js \
               src/utils/__tests__/sanitize-html-mail.test.js \
               src/utils/__tests__/mail-actions.test.js
```

> 已实现验证：`mail-actions.test.js`（6）+ `remote-content-policy.test.js`（48）+ `sanitize-html-mail.test.js`（11）+ `sanitize-html.test.js`（8），以及 `frontend/src/utils` 全量 **92 条测试全绿**；`vite build --mode example` 通过（含 `UnifiedInboxDetail-*.js`、`SendMail*.js` chunk 正常产出）。

---

### 生产级 review 后再修（根因）

在开发文档实现后做了一次生产级 review，补上以下根因修复：

| 项 | 问题 | 根因修复 |
|----|------|---------|
| P1 | `remote-content-policy.js:137` 头注释仍声称「mail-actions 独立 purifier 保留图片」，与实现相悖 | 更新注释为「单 purifier 确保邮件正文与回信引用统一严格阻断」 |
| P2 | `SendMail.vue` 的 `sanitize-html.js` 注释声称「发送前最后一层防线」，但 `send()` 其实 `content` 原样发出，编辑器/粘贴/回信引用片段的 `javascript:`/事件属性可能带入收件人客户端 | `send()` 发送前按 `contentType` 兜底净化（`html`/`rich` 走 `sanitizeHtml`，`text` 按原样以防字面 `<` 被误解析） |
| P3 | `detail.htmlBlocked` 中文「已阻断」与主阅读器 `remoteImagesBlocked`「已阻止」一字不一致 | 统一为「已阻止 N 项外部资源以保护隐私」 |

---

## 七、遗留决策 / 待确认

- **是否给统一收件箱信任 full-screen 视图**：`fullscreen`（`MailContentRenderer.vue`）也复用同一 `processedMail`，这里统一收件箱若是单视图则无需另行处理；若统一详情也支持全屏，沿用同一 `htmlBody` 即可。
- **稿件是否要用户级全局「自动加载远程图片」开关（`autoLoadRemoteImages`）**：主阅读器已接；统一收件箱当前无需接入，若后续要统一可在 `UnifiedInboxDetail` 同样读 `useGlobalState().autoLoadRemoteImages` 作为默认分支（本方案默认不接，保持最低变更度）。