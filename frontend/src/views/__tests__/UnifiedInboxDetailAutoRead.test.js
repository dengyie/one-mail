// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ctx, email, flush, mount } from './unified-workspace-harness.js'
import UnifiedInboxDetail from '../UnifiedInboxDetail.vue'

describe('reading a mail marks it read', () => {
  it('downloads stored attachments through the unified API', async () => {
    ctx.api.unified.getEmail.mockResolvedValue({ ...email('mail-a'), is_read: 1, attachments_json: JSON.stringify([{ id: 'att-1', name: 'x.txt', size: 2, mimeType: 'text/plain', downloadable: true }]) })
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { host } = await mount(UnifiedInboxDetail)
    const download = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Download'))
    download.click()
    await flush()
    expect(ctx.api.unified.downloadAttachment).toHaveBeenCalledWith('mail-a', 'att-1', expect.anything())
    expect(createUrl).toHaveBeenCalled()
    revokeUrl.mockRestore(); createUrl.mockRestore()
  })

  it('marks an unread mail read as soon as the detail view opens it', async () => {
    const unread = email('mail-a')
    ctx.api.unified.getEmail.mockResolvedValue(unread)
    ctx.api.unified.markRead.mockResolvedValue({ is_read: 1 })

    const { host } = await mount(UnifiedInboxDetail)

    expect(ctx.api.unified.getEmail).toHaveBeenCalledWith('mail-a', expect.anything())
    expect(ctx.api.unified.markRead).toHaveBeenCalledWith('mail-a', expect.anything())
    expect(host.querySelector('.n-tag')?.textContent).toContain('Read')
  })

  it('renders the body before the read marker settles', async () => {
    let resolveMark
    ctx.api.unified.getEmail.mockResolvedValue(email('mail-a'))
    ctx.api.unified.markRead.mockReturnValue(new Promise(resolve => { resolveMark = resolve }))

    const { host } = await mount(UnifiedInboxDetail)
    await flush()

    expect(host.textContent).toContain('Private mail A')
    resolveMark({ is_read: 1 })
    await flush()
    expect(host.textContent).toContain('Private mail A')
  })

  it('does not mark a mail that is already read', async () => {
    ctx.api.unified.getEmail.mockResolvedValue({ ...email('mail-a'), is_read: 1 })

    await mount(UnifiedInboxDetail)

    expect(ctx.api.unified.markRead).not.toHaveBeenCalled()
  })

  it('keeps the mail unread and reports the failure when the provider rejects', async () => {
    const unread = email('mail-a')
    ctx.api.unified.getEmail.mockResolvedValue(unread)
    ctx.api.unified.markRead.mockRejectedValue(new Error('source mailbox offline'))

    const { host } = await mount(UnifiedInboxDetail)
    await flush()

    expect(unread.is_read).toBe(0)
    expect(ctx.messages.error).toHaveBeenCalledWith('source mailbox offline')
    expect(host.querySelector('button')?.textContent).not.toContain('Mark as read')
  })

  it('drops a late provider response that arrives after the mail changed', async () => {
    const first = email('mail-a')
    const second = { ...email('mail-b'), is_read: 1 }
    let resolveMark
    ctx.api.unified.getEmail.mockResolvedValueOnce(first)
    ctx.api.unified.markRead.mockReturnValue(new Promise(resolve => { resolveMark = resolve }))

    await mount(UnifiedInboxDetail)
    await flush()
    expect(ctx.api.unified.markRead).toHaveBeenCalledWith('mail-a', expect.anything())

    ctx.route.params.id = 'mail-b'
    ctx.api.unified.getEmail.mockResolvedValue(second)
    await flush()
    resolveMark({ is_read: 0 })
    await flush()

    expect(second.is_read).toBe(1)
    expect(ctx.api.unified.markRead).toHaveBeenCalledTimes(1)
  })
})
