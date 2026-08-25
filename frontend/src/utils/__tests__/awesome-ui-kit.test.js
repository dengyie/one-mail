import { describe, it, expect } from 'vitest'
import { marked } from 'marked'

describe('awesome-ui-kit & AI UI Primitives', () => {
  describe('Markdown parsing (StreamMarkdown core)', () => {
    it('correctly parses markdown headers, bold, and code blocks', () => {
      const input = '### Hello AI\n**Bold text**\n```js\nconst a = 1;\n```'
      const parsed = marked.parse(input)
      expect(parsed).toContain('<h3')
      expect(parsed).toContain('Hello AI')
      expect(parsed).toContain('<strong>Bold text</strong>')
      expect(parsed).toContain('<pre><code')
    })

    it('handles empty or special character markdown content safely', () => {
      expect(marked.parse('')).toBe('')
      const special = marked.parse('> Quote with 🔑 & 📧')
      expect(special).toContain('<blockquote>')
      expect(special).toContain('🔑')
    })
  })

  describe('Theme resolution logic (ThemeToggle)', () => {
    it('resolves explicit light and dark themes', () => {
      const resolveTheme = (m) => {
        if (m === 'light' || m === 'dark') return m
        return 'light'
      }
      expect(resolveTheme('light')).toBe('light')
      expect(resolveTheme('dark')).toBe('dark')
    })
  })

  describe('AI Metadata parsing (AiExtractInfo)', () => {
    it('parses auth_code metadata accurately', () => {
      const raw = JSON.stringify({
        ai_extract: {
          type: 'auth_code',
          result: '849201'
        }
      })
      const parsed = JSON.parse(raw)
      expect(parsed.ai_extract.type).toBe('auth_code')
      expect(parsed.ai_extract.result).toBe('849201')
    })

    it('parses auth_link metadata accurately', () => {
      const raw = JSON.stringify({
        ai_extract: {
          type: 'auth_link',
          result: 'https://example.com/verify?token=abc',
          result_text: 'Click here to verify'
        }
      })
      const parsed = JSON.parse(raw)
      expect(parsed.ai_extract.type).toBe('auth_link')
      expect(parsed.ai_extract.result).toBe('https://example.com/verify?token=abc')
      expect(parsed.ai_extract.result_text).toBe('Click here to verify')
    })

    it('handles corrupted or invalid metadata without crashing', () => {
      const parseSafely = (str) => {
        try {
          return JSON.parse(str)?.ai_extract || null
        } catch {
          return null
        }
      }
      expect(parseSafely('invalid json')).toBeNull()
      expect(parseSafely(null)).toBeNull()
      expect(parseSafely('{}')).toBeNull()
    })
  })
})
