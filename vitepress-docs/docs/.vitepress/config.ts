import { defineConfig } from 'vitepress'
import { zh } from './zh'
import { en } from './en'

export default defineConfig({
  title: "Temp Mail Doc",
  description: 'CloudFlare 免费收发临时域名邮箱 | Free temporary domain email on CloudFlare',
  lang: 'zh-CN',
  lastUpdated: true,
  locales: {
    zh: { label: '简体中文', ...zh },
    en: { label: 'English', ...en }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
    ['meta', { name: 'theme-color', content: '#5f67ee' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:locale:alternate', content: 'en_US' }],
    ['meta', { property: 'og:title', content: 'Temp Mail - CloudFlare 临时邮箱' }],
    ['meta', { property: 'og:description', content: 'CloudFlare 免费收发临时域名邮箱，支持多域名、附件、Telegram Bot、Webhook、SMTP/IMAP' }],
    ['meta', { property: 'og:site_name', content: 'Temp Mail' }],
    ['meta', { property: 'og:image', content: 'https://temp-mail-docs.pages.dev/logo.png' }],
    ['meta', { property: 'og:url', content: 'https://temp-mail-docs.pages.dev' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: 'Temp Mail - CloudFlare 临时邮箱' }],
    ['meta', { name: 'twitter:description', content: 'CloudFlare 免费收发临时域名邮箱' }],
    ['meta', { name: 'twitter:image', content: 'https://temp-mail-docs.pages.dev/logo.png' }],
    ['link', { rel: 'alternate', hreflang: 'zh-Hans', href: 'https://temp-mail-docs.pages.dev/zh/' }],
    ['link', { rel: 'alternate', hreflang: 'en', href: 'https://temp-mail-docs.pages.dev/en/' }],
    ['link', { rel: 'alternate', hreflang: 'x-default', href: 'https://temp-mail-docs.pages.dev/zh/' }],
  ],
  sitemap: {
    hostname: 'https://temp-mail-docs.pages.dev',
    transformItems(items) {
      return items.filter((item) => !item.url.includes('migration'))
    }
  },
  themeConfig: {
    logo: { src: '/logo.png', width: 24, height: 24 },
    search: { provider: 'local' },
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/dengyie/one-mail'
      }
    ]
  }
})
