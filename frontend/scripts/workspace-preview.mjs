// Local browser fixtures only. Never imported by the application bundle.
// installWorkspacePreview(page) intercepts API requests before they leave the
// browser, so screenshots and interaction checks cannot touch real mail.
export async function installWorkspacePreview(page, { signedIn = true, admin = false } = {}) {
  await page.unrouteAll({ behavior: 'wait' })
  const now = Date.now()
  const accounts = [
    { id: 'personal', label: '个人邮箱', username: 'mango@example.com', source: 'imap_gmail', provider: 'gmail', enabled: 1, can_send: 1, protocol: 'imap', host: 'imap.example.com', port: 993 },
    { id: 'work', label: '工作邮箱', username: 'studio@example.net', source: 'imap_outlook', provider: 'outlook', enabled: 1, can_send: 1, protocol: 'imap', host: 'imap.example.net', port: 993 },
  ]
  const topics = [
    ['Linear', 'notifications@linear.example', '本周的工作，都在这里。', 'imap_gmail', false, true],
    ['Figma', 'updates@figma.example', '设计周刊 #42：让复杂的事，变得简单', 'imap_gmail', false, false],
    ['GitHub', 'noreply@github.example', '你的登录验证码是 482 916', 'cf_routing', false, false],
    ['林晓', 'lin@studio.example', 'One Mail 的下一步，一起聊聊', 'imap_outlook', true, true],
    ['Notion', 'team@notion.example', '为你的下一次灵感，留一点空间', 'imap_gmail', true, false],
    ['Vercel', 'notifications@vercel.example', 'Your deployment is ready', 'imap_gmail', true, false],
    ['Read.cv', 'hello@read.example', 'Small things, thoughtfully made.', 'imap_outlook', true, false],
  ]
  const emails = topics.map(([name, from, subject, source, read, star], index) => ({
    id: `preview-${index + 1}`, from_addr: `${name} <${from}>`, to_addr: source === 'imap_outlook' ? 'studio@example.net' : 'mango@example.com',
    account_id: source === 'imap_outlook' ? 'work' : 'personal', subject, source, is_read: read ? 1 : 0, is_starred: star ? 1 : 0,
    received_at: now - index * 45 * 60 * 1000,
    text_body: `你好，Mango：\n\n这是一封用于界面验收的示例邮件。\n\n我们整理了本周值得关注的进展。更清晰的工作空间，从每一件小事开始。\n\n祝你有专注、从容的一天。\nThe One Mail team`,
    html_body: index === 0 ? '<div style="font-family: sans-serif; line-height: 1.9; max-width: 640px"><h2 style="font-size: 20px">把时间留给真正重要的事。</h2><p>你好，Mango：</p><p>我们整理了本周值得关注的进展。更清晰的工作空间，从每一件小事开始。</p><p>你现在可以在一个收件箱里查看所有来信，给重要邮件加星标，并随时回到自己的节奏。</p><p>祝你有专注、从容的一天。<br>The One Mail team</p><img src="https://images.example.invalid/preview.png" alt="示例远程图片" /></div>' : '',
    attachments_json: index === 0 ? JSON.stringify([{ name: 'weekly-notes.pdf', size: 248000, mimeType: 'application/pdf' }]) : '[]',
  }))
  const state = { emails, accounts, requests: [], failNextMutation: false, failList: false, empty: false, degraded: false, signedIn, admin }
  page.workspacePreview = state
  await page.addInitScript(({ signedIn }) => {
    localStorage.setItem('userJwt', signedIn ? 'local-preview-user' : '')
    localStorage.setItem('jwt', signedIn ? 'local-preview-address' : '')
    localStorage.setItem('unifiedApiKey', '')
    localStorage.setItem('adminAuth', '')
    localStorage.setItem('preferredLocale', 'zh')
    localStorage.setItem('one-mail-theme-mode', 'light')
    localStorage.setItem('color-scheme', 'light')
  }, { signedIn })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
    // App routes such as /admin still need Vite's HTML entry point.
    if (route.request().isNavigationRequest()) return route.continue()
    if (!/^\/(api|user_api|open_api|admin|external|telegram)(\/|$)/.test(url.pathname)) return route.continue()
    const method = route.request().method()
    state.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: route.request().postData() })
    let json = {}
    let status = 200
    const path = url.pathname
    if (path === '/open_api/settings') json = { title: 'One Mail', domains: ['example.com', 'example.net'], enableSendMail: true, enableUserCreateEmail: true, enableUserDeleteEmail: true, enableWebhook: true, showGithub: true, showGithubForUser: true, enableAddressPassword: true, copyright: 'One Mail' }
    else if (path === '/user_api/settings') json = { user_id: 1, user_email: 'mango@example.com', is_admin: state.admin, user_role: null }
    else if (path === '/user_api/open_settings') json = { enable: true, enableMailVerify: false, oauth2ClientIDs: [] }
    else if (path === '/api/settings') json = { address: 'mango@example.com', send_balance: 100, auto_reply: { enabled: false } }
    else if (path === '/user_api/bind_address') json = { results: [{ id: 1, name: 'mango@example.com', created_at: '2026-10-01 08:00:00', is_external: 0 }], count: 1 }
    else if (path.startsWith('/user_api/bind_address_jwt')) json = { jwt: 'local-preview-address' }
    else if (path === '/user_api/mail_accounts') json = { results: accounts, count: accounts.length }
    else if (path === '/api/unified/meta') json = { sources: ['imap_gmail', 'imap_outlook', 'cf_routing'], accounts: ['personal', 'work'], to_addrs: ['mango@example.com', 'studio@example.net'] }
    else if (path === '/api/unified/stats') json = { count: emails.length, unread: 3, sources: ['imap_gmail', 'imap_outlook', 'cf_routing'], accounts: ['personal', 'work'] }
    else if (path === '/api/unified/emails') {
      if (state.failList) { status = 503; json = { error: 'Local preview: connection unavailable' } }
      else {
        let results = state.empty ? [] : emails
        const q = (url.searchParams.get('q') || '').toLowerCase()
        if (q) results = results.filter(row => `${row.subject} ${row.from_addr}`.toLowerCase().includes(q))
        if (url.searchParams.get('unread') === '1') results = results.filter(row => !row.is_read)
        if (url.searchParams.get('starred') === '1') results = results.filter(row => row.is_starred)
        if (url.searchParams.get('source')) results = results.filter(row => row.source === url.searchParams.get('source'))
        if (url.searchParams.get('to_addr')) results = results.filter(row => row.to_addr === url.searchParams.get('to_addr'))
        if (url.searchParams.get('account_id')) results = results.filter(row => row.account_id === url.searchParams.get('account_id'))
        const start = Number((url.searchParams.get('cursor') || '').replace('preview-cursor-', '') || url.searchParams.get('offset') || 0)
        const end = start + Number(url.searchParams.get('limit') || 20)
        json = {
          results: results.slice(start, end),
          count: state.degraded ? null : url.searchParams.get('with_count') === '0' ? 0 : results.length,
          has_more: state.degraded || end < results.length,
          next_cursor: !state.degraded && end < results.length ? `preview-cursor-${end}` : null,
          degraded: state.degraded ? ['preview-shard'] : undefined,
        }
      }
    } else if (/\/api\/unified\/emails\//.test(path)) {
      const [, id, action] = path.match(/\/emails\/([^/]+)(?:\/(.*))?/) || []
      const email = emails.find(row => row.id === id)
      if (!email) { status = 404; json = { error: 'Not found' } }
      else if (method === 'POST') {
        if (state.failNextMutation) { state.failNextMutation = false; status = 503; json = { error: 'Local preview: write rejected' } }
        else {
          if (action === 'star') email.is_starred = JSON.parse(route.request().postData() || '{}').is_starred ?? (email.is_starred ? 0 : 1)
          if (action === 'read' || action === 'unread') email.is_read = action === 'read' ? 1 : 0
          json = { success: true, is_starred: email.is_starred }
        }
      } else json = email
    } else if (path === '/api/unified/verifcodes') json = { results: [{ code: '482916', subject: topics[2][2], from_addr: 'GitHub <noreply@github.example>', to_addr: 'mango@example.com', received_at: now }], count: 1 }
    else if (path.includes('passkey')) json = { results: [] }
    else if (path.includes('sendbox') || path === '/api/mails') json = { results: [], count: 0 }
    else if (method !== 'GET') { status = 501; json = { error: 'This write is disabled in the local UI preview.' } }
    else json = { results: [], count: 0 }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })
  })
  return state
}
