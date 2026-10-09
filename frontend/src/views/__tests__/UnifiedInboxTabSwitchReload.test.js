// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ctx, email, flush, mount } from './unified-workspace-harness'
import UnifiedInbox from '../UnifiedInbox.vue'

describe('UnifiedInbox tab switch reload contract', () => {
  it('reloads the mail list immediately when switching back from the codes tab', async () => {
    // 从 URL 深链直接进入 codes 页签：activeTab 初始即为 'codes'。
    ctx.route.query = { tab: 'codes' }
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email()], count: null, next_cursor: null, has_more: false })
    const { host } = await mount(UnifiedInbox)

    // 前置条件 1：当前停在 codes 页签（其数据已按需加载）。naive-ui 的
    // n-tab-pane 默认 display-directive="if"，未激活的页签根本不渲染，所以这
    // 一对断言是配对的：切换前没有 list 工具栏，切换后才有。
    expect(ctx.api.unified.verifcodes).toHaveBeenCalled()
    expect(host.querySelector('.inbox-toolbar')).toBeNull()
    // 前置条件 2：列表在 codes 页签期间不会被轮询刷新，只有挂载时的那一次首屏读取。
    const callsBeforeSwitch = ctx.api.unified.listEmails.mock.calls.length
    expect(callsBeforeSwitch).toBe(1)

    // 停在 codes 页签期间新邮件到达（验证码页有独立轮询，所以那边已经看到了）。
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('mail-b', 'Freshly arrived mail')], count: null, next_cursor: null, has_more: false })

    // 用户从 codes 切回 list —— 路由查询里的 tab 是第 7 个键。
    ctx.route.query = { tab: 'list' }
    await flush()
    // 前置条件 3：activeTab 确实已经切到 list（列表页签重新渲染出工具栏）。
    expect(host.querySelector('.inbox-toolbar')).not.toBeNull()

    // 回归契约 1：切回列表必须立刻重新拉取邮件列表，而不是等下一次轮询 tick。
    // 这条也顺手钉住路由 watch 不会重复触发 loadList。
    expect(ctx.api.unified.listEmails.mock.calls.length).toBe(callsBeforeSwitch + 1)
    // 回归契约 2：用户真的看见了新邮件。光数请求次数是测不出来的——mock 回同一
    // 份载荷时，「调了 loadList 但把响应丢掉」和「真的刷新了」渲染结果完全一致。
    expect(host.textContent).toContain('Freshly arrived mail')
    // 回归契约 3：切页签只是回流、不改筛选，别顺手再跑一次全表 COUNT(*)
    // （D1 免费档 rows_read 就是这么被打爆的）。
    const params = ctx.api.unified.listEmails.mock.calls.at(-1)[0]
    expect(params).toMatchObject({ with_count: 0, limit: 20 })
    expect(params.cursor).toBeUndefined()
  })
})
