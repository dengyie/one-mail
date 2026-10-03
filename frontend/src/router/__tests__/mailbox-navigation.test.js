/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import { LOCALE_PATH_PATTERN, resolveMailboxRedirect } from '../../i18n/utils'

const Dummy = { template: '<div />' }

const makeRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      component: Dummy,
    },
    {
      path: '/unified',
      alias: `/:lang(${LOCALE_PATH_PATTERN})/unified`,
      component: Dummy,
    },
    {
      path: '/mailbox',
      alias: [
        `/:lang(${LOCALE_PATH_PATTERN})/mailbox`,
        '/mailbox/',
        `/:lang(${LOCALE_PATH_PATTERN})/mailbox/`,
      ],
      redirect: (to) => {
        const target = resolveMailboxRedirect(to.fullPath)
        if (!target) {
          return { name: 'not-found' }
        }
        return target
      },
    },
    {
      name: 'not-found',
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

describe('mailbox vue-router navigation', () => {
  it('pushes /mailbox with query and hash onto /unified', async () => {
    const router = makeRouter()
    await router.push('/mailbox?foo=1#h')
    expect(router.currentRoute.value.fullPath).toBe('/unified?foo=1#h')
  })

  it('keeps non-default locale prefixes including pt-BR', async () => {
    const router = makeRouter()
    await router.push('/en/mailbox')
    expect(router.currentRoute.value.fullPath).toBe('/en/unified')

    await router.push('/pt-BR/mailbox?tab=list')
    expect(router.currentRoute.value.fullPath).toBe('/pt-BR/unified?tab=list')

    await router.push('/zh/mailbox?jwt=abc')
    expect(router.currentRoute.value.fullPath).toBe('/unified?jwt=abc')
  })

  it('does not send unsupported locale mailbox paths to unified', async () => {
    const router = makeRouter()
    await router.push('/fr/mailbox')
    expect(router.currentRoute.value.fullPath).toBe('/')

    await router.push('/foo/mailbox')
    expect(router.currentRoute.value.fullPath).toBe('/')
  })
})
