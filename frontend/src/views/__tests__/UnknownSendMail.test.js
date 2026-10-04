import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../admin/UnknownSendMail.vue', import.meta.url)), 'utf8')
const admin = readFileSync(fileURLToPath(new URL('../Admin.vue', import.meta.url)), 'utf8')
const sidebar = readFileSync(fileURLToPath(new URL('../../components/layout/AppSidebar.vue', import.meta.url)), 'utf8')
const router = readFileSync(fileURLToPath(new URL('../../router/index.js', import.meta.url)), 'utf8')

describe('admin unknown delivery page contracts', () => {
  it('lists and resolves unknown send-mail reservations', () => {
    expect(view).toContain("api.fetch('/admin/send_mail/unknown?limit=100')")
    expect(view).toContain('`/admin/send_mail/unknown/${row.id}/resolve`')
    expect(view).toContain("resolveRow(row, 'sent')")
    expect(view).toContain("resolveRow(row, 'rejected')")
  })

  it('auto-refreshes only while visible and cleans up the timer', () => {
    expect(view).toContain('const AUTO_REFRESH_MS = 15000')
    expect(view).toContain("document.visibilityState !== 'visible'")
    expect(view).toContain('window.setInterval(autoRefreshList, AUTO_REFRESH_MS)')
    expect(view).toContain('stopAutoRefresh()')
  })

  it('admin sendbox auto-refresh is opt-in and off by default', () => {
    const sendBox = readFileSync(fileURLToPath(new URL('../admin/SendBox.vue', import.meta.url)), 'utf8')
    expect(sendBox).toContain('const autoRefresh = ref(false)')
    expect(sendBox).toContain(':auto-refresh="autoRefresh"')
    expect(sendBox).not.toContain(':auto-refresh="true"')
  })

  it('is mounted at /admin/send-unknown from router, Admin.vue and the sidebar', () => {
    expect(router).toContain("path: '/admin/send-unknown'")
    expect(admin).toContain("if (p.includes('/admin/send-unknown')) return 'send_unknown'")
    expect(admin).toContain('<UnknownSendMail />')
    expect(sidebar).toContain("handleNavigate('/admin/send-unknown')")
    expect(sidebar).toContain("handleNavigate('/admin/sender-access')")
    expect(sidebar).toContain("handleNavigate('/admin/sendmail')")
  })
})
