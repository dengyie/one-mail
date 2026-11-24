/**
 * Agent Mail（agent.qq.com）provider 数据与接入凭据构造。
 *
 * Agent 邮箱是纯 REST + OAuth 源（无 IMAP/POP3 端点），凭据 = OAuth
 * refresh_token（来自官方 `agently-cli auth login` 设备流）。RT 与签发它的
 * 客户端绑定：只有 CLI 签发的 RT 能用 CLI 的 client_id 兑换（实测混用报
 * invalid_grant，docs/external-mailbox-pipeline-upgrade.md §3A.2），所以
 * client_id 必须与 CLI 内嵌值一致，由本模块固定注入，用户只需粘贴 RT。
 */

// 与 agently-cli 内嵌 client_id 一致（docs §3A.2：RT 绑定签发批次）。
export const AGENTLY_CLIENT_ID = 'cli_002e8cd1a3bd2eb8'

export const AGENTLY_MAIL_HOST = 'api.agent.qq.com'

// UI 提示兜底文案（i18n 键 agentMailIntro 缺失时使用）。
export const AGENTLY_INTRO_FALLBACK = 'Agent 邮箱（agent.qq.com）无密码，使用 OAuth 接入：' +
    '在终端运行 agently-cli auth login 并完成浏览器授权后，把获得的 refresh_token 粘贴到下方。' +
    '授权一次后由系统自动续期，无需重复操作。'

export function isAgentlyProvider(provider) {
    return provider === 'agent'
}

// Agent 邮箱接入凭据 = 用户粘贴的 refresh_token（单行字符串）。只做形状兜底
// 校验，长度与有效性交给服务端/聚合器判（CLI 签发的 RT 实测 128 字符）。
export function parseAgentlyRefreshToken(raw) {
    const rt = String(raw || '').trim()
    return rt.length >= 32 && /^[\w-]+$/.test(rt) ? rt : null
}

export function buildAgentlyOauth(refreshToken) {
    return JSON.stringify({ provider: 'agently', client_id: AGENTLY_CLIENT_ID, refresh_token: refreshToken })
}
