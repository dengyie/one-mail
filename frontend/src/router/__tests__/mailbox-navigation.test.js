/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import { LOCALE_PATH_PATTERN, resolveHomeRedirect, resolveMailboxRedirect } from '../../i18n/utils'

const Dummy = { template: '<div />' }

const makeRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      redirect: (to) => {
        const target = resolveHomeRedirect(to.fullPath)
        if (!target) {
          return { name: 'not-found' }
        }
        return target
      },
    },
    {
      path: `/:lang(${LOCALE_PATH_PATTERN})`,
      alias: `/:lang(${LOCALE_PATH_PATTERN})/`,
      redirect: (to) => {
        const target = resolveHomeRedirect(to.fullPath)
        if (!target) {
          return { name: 'not-found' }
        }
        return target
      },
    },
    {
      path: '/temp-mail',
      component: Dummy,
    },
    {
      path: `/:lang(${LOCALE_PATH_PATTERN})/temp-mail`,
      component: Dummy,
    },
    {
      path: '/unified',
      component: Dummy,
    },
    {
      path: `/:lang(${LOCALE_PATH_PATTERN})/unified`,
      component: Dummy,
    },
    {
      path: '/mailbox',
      alias: '/mailbox/',
      redirect: (to) => {
        const target = resolveMailboxRedirect(to.fullPath)
        if (!target) {
          return { name: 'not-found' }
        }
        return target
      },
    },
    {
      path: `/:lang(${LOCALE_PATH_PATTERN})/mailbox`,
      alias: `/:lang(${LOCALE_PATH_PATTERN})/mailbox/`,
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
      redirect: '/unified',
    },
  ],
})

describe('mailbox vue-router navigation', () => {
  it('pushes root / with query and hash onto /unified', async () => {
    const router = makeRouter()
    await router.push('/?tab=list#anchor')
    expect(router.currentRoute.value.fullPath).toBe('/unified?tab=list#anchor')
  })

  it('keeps non-default locale prefixes when pushing root', async () => {
    const router = makeRouter()
    await router.push('/en/')
    expect(router.currentRoute.value.fullPath).toBe('/en/unified')

    await router.push('/pt-BR')
    expect(router.currentRoute.value.fullPath).toBe('/pt-BR/unified')
  })

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

  it('does not send unsupported locale mailbox paths to unified locale paths and falls back to home', async () => {
    const router = makeRouter()
    await router.push('/fr/mailbox')
    expect(router.currentRoute.value.fullPath).not.toBe('/fr/unified')
    expect(router.currentRoute.value.fullPath).toBe('/unified')

    await router.push('/foo/mailbox')
    expect(router.currentRoute.value.fullPath).not.toBe('/foo/unified')
    expect(router.currentRoute.value.fullPath).toBe('/unified')
  })
})
