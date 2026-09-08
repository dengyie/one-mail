import { Context, Hono } from 'hono'
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt'
import { Jwt } from 'hono/utils/jwt'
import { verifyActiveAddressJwt } from './core/auth'

import { api as commonApi } from './commom_api';
import { api as openAuthApi } from './open_api/auth';
import { api as mailsApi } from './mails_api'
import { api as userApi } from './user_api';
import { api as adminApi } from './admin_api';
import { api as apiSendMail } from './mails_api/send_mail_api'
import { api as telegramApi } from './telegram_api'
import unifiedApi from './unified'

import i18n from './i18n';
import { email } from './email';
import { scheduled } from './scheduled';
import { getPasswords, getBooleanValue, getDomains, checkIsAdmin } from './utils';
import { checkAccessControl } from './ip_blacklist';
import { recordAdminFailure, clearAdminFailures, decideAdminAuth, getAdminFailCount } from './unified/admin_lockout';

import { resolveCorsOrigin } from './cors_policy';

const API_PATHS = [
	"/api/",
	"/open_api/",
	"/user_api/",
	"/admin/",
	"/telegram/",
	"/external/",
];

const app = new Hono<HonoCustomType>()
// Restrict browser credentials to the deployed UI. External integrations use
// explicit API credentials and do not need a wildcard browser origin.
app.use('/*', cors({
	origin: (origin, c) => resolveCorsOrigin(origin, c.env.FRONTEND_URL),
	allowHeaders: [
		'Content-Type', 'Authorization', 'x-user-token', 'x-user-access-token',
		'x-custom-auth', 'x-admin-auth', 'x-lang', 'x-fingerprint',
	],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
// error handler
app.onError((err, c) => {
	console.error(err)
	return c.text(`${err.name} ${err.message}`, 500)
})
// global middlewares
app.use('/*', async (c, next) => {

	// check if the request is for static files
	if (c.env.ASSETS && !API_PATHS.some(path => c.req.path.startsWith(path))) {
		const url = new URL(c.req.raw.url);
		if (!url.pathname.includes('.')) {
			url.pathname = ""
		}
		return c.env.ASSETS.fetch(url);
	}

	// save language in context
	const lang = c.req.raw.headers.get("x-lang");
	if (lang) { c.set("lang", lang); }
	const msgs = i18n.getMessages(lang || c.env.DEFAULT_LANG);

	// check header x-custom-auth
	const passwords = getPasswords(c);
	if (!c.req.path.startsWith("/open_api") && !c.req.path.startsWith("/telegram/") && passwords && passwords.length > 0) {
		const auth = c.req.raw.headers.get("x-custom-auth");
		if (!auth || !passwords.includes(auth)) {
			return c.text(msgs.CustomAuthPasswordMsg, 401)
		}
	}

	// rate limit for specific endpoints
	if (
		c.req.path.startsWith("/api/new_address")
		|| c.req.path.startsWith("/api/send_mail")
		|| c.req.path.startsWith("/external/api/send_mail")
		|| c.req.path.startsWith("/user_api/register")
		|| c.req.path.startsWith("/user_api/verify_code")
	) {
		const reqIp = c.req.raw.headers.get("cf-connecting-ip")
		if (reqIp && c.env.RATE_LIMITER) {
			const { success } = await c.env.RATE_LIMITER.limit(
				{ key: `${c.req.path}|${reqIp}` }
			)
			if (!success) {
				return c.text(`IP=${reqIp} Rate limit exceeded for ${c.req.path}`, 429)
			}
		}
		// Check access control (blacklist and daily limit)
		const accessControlResponse = await checkAccessControl(c);
		if (accessControlResponse) {
			return accessControlResponse;
		}
	}
	// webhook check
	if (
		c.req.path.startsWith("/api/webhook")
		|| c.req.path.startsWith("/admin/webhook")
		|| c.req.path.startsWith("/admin/mail_webhook")
	) {
		if (!c.env.KV) {
			return c.text(msgs.KVNotAvailableMsg, 400);
		}
		if (!getBooleanValue(c.env.ENABLE_WEBHOOK)) {
			return c.text(msgs.WebhookNotEnabledMsg, 403);
		}
	}
	if (!c.env.DB) {
		return c.text(msgs.DBNotAvailableMsg, 400);
	}
	if (!c.env.JWT_SECRET) {
		return c.text(msgs.JWTSecretNotSetMsg, 400);
	}
	await next()
});

const checkUserPayload = async (
	c: Context<HonoCustomType>
): Promise<void> => {
	try {
		const token = c.req.raw.headers.get("x-user-token");
		if (!token) return;
		const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
		// check expired
		if (!payload.exp) return;
		// exp is in seconds
		if (payload.exp < Math.floor(Date.now() / 1000)) {
			return;
		}
		c.set("userPayload", payload as UserPayload);
	} catch (e) {
		console.error(e);
	}
}

const checkoutUserRolePayload = async (
	c: Context<HonoCustomType>
): Promise<void> => {
	try {
		const token = c.req.raw.headers.get("x-user-access-token");
		if (!token) return;
		const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
		// check expired
		if (!payload.exp) return;
		// exp is in seconds
		if (payload.exp < Math.floor(Date.now() / 1000)) {
			return;
		}
		if (typeof payload?.user_role !== "string") return;
		c.set("userRolePayload", payload.user_role);
	} catch (e) {
		console.error(e);
	}
}

// api auth
app.use('/api/*', async (c, next) => {
	if (c.req.path.startsWith("/api/new_address")) {
		await checkUserPayload(c);
		await next();
		return;
	}
	if (c.req.path.startsWith("/api/settings")
		|| c.req.path.startsWith("/api/send_mail")
	) {
		await checkoutUserRolePayload(c);
	}
	if (c.req.path.startsWith("/api/address_login")) {
		await next();
		return;
	}
	if (c.req.path.startsWith("/api/unified")) {
		// 用户登录通道：可选填充 userPayload（无 token 时为空，留给 unified
		// 中间件按 Bearer API-key 处理或返回 401）。与 /api/new_address 同样的
		// 非强制语义。
		await checkUserPayload(c);
		await next();
		return;
	}

	// 地址 JWT 校验（签名、过期时间和当前地址绑定）。删除或替换地址后，旧凭据立即失效。
	// 抽取逻辑与 hono jwt() 中间件一致：Authorization: Bearer <token>，失败 401。
	const token = c.req.raw.headers.get("Authorization");
	if (!token) {
		const lang = c.get("lang") || c.env.DEFAULT_LANG;
		const msgs = i18n.getMessages(lang);
		return c.text(msgs.InvalidAddressCredentialMsg, 401);
	}
	const parts = token.split(/\s+/);
	if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
		const lang = c.get("lang") || c.env.DEFAULT_LANG;
		const msgs = i18n.getMessages(lang);
		return c.text(msgs.InvalidAddressCredentialMsg, 401);
	}
	const payload = await verifyActiveAddressJwt(c, parts[1]);
	if (!payload) {
		const lang = c.get("lang") || c.env.DEFAULT_LANG;
		const msgs = i18n.getMessages(lang);
		return c.text(msgs.InvalidAddressCredentialMsg, 401);
	}
	c.set("jwtPayload", payload as JwtPayload);
	await next();
	return;
});
// user_api auth
app.use('/user_api/*', async (c, next) => {
	if (
		c.req.path.startsWith("/user_api/open_settings")
		|| c.req.path.startsWith("/user_api/register")
		|| c.req.path.startsWith("/user_api/login")
		|| c.req.path.startsWith("/user_api/verify_code")
		|| c.req.path.startsWith("/user_api/passkey/authenticate_")
		|| c.req.path.startsWith("/user_api/oauth2")
	) {
		await next();
		return;
	}

	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;
	const msgs = i18n.getMessages(lang);

	try {
		const token = c.req.raw.headers.get("x-user-token");
		if (!token) return c.text(msgs.UserTokenExpiredMsg, 401)
		const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
		// check expired
		if (!payload.exp) return c.text(msgs.UserTokenExpiredMsg, 401);
		// exp is in seconds
		if (payload.exp < Math.floor(Date.now() / 1000)) {
			return c.text(msgs.UserTokenExpiredMsg, 401)
		}
		c.set("userPayload", payload as UserPayload);
	} catch (e) {
		console.error(e);
		return c.text(msgs.UserTokenExpiredMsg, 401)
	}
	if (c.req.path.startsWith("/user_api/bind_address")) {
		await checkoutUserRolePayload(c);
	}
	if (c.req.path.startsWith('/user_api/bind_address')
		&& c.req.method === 'POST'
	) {
		return jwt({ secret: c.env.JWT_SECRET, alg: "HS256" })(c, next);
	}
	await next();
});
// admin auth
app.use('/admin/*', async (c, next) => {

	const hasAdminAuth = !!c.req.raw.headers.get("x-admin-auth");
	const hasAccessToken = !!c.req.raw.headers.get("x-user-access-token");
	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;

	// 解析 x-user-access-token（verify 抛错 -> null，decideAdminAuth 按 R2 处理）
	let accessTokenPayload: { exp?: number; user_role?: unknown } | null = null;
	if (hasAccessToken) {
		try {
			const raw = c.req.raw.headers.get("x-user-access-token") as string;
			accessTokenPayload = await Jwt.verify(raw, c.env.JWT_SECRET, "HS256") as { exp?: number; user_role?: unknown };
		} catch { /* verify 抛错 -> null */ }
	}

	const decision = await decideAdminAuth({
		hasAdminAuth,
		hasAccessToken,
		adminAuthValid: await checkIsAdmin(c),
		adminFailCount: await getAdminFailCount(c),
		adminUserRole: c.env.ADMIN_USER_ROLE,
		disableAdminPasswordCheck: getBooleanValue(c.env.DISABLE_ADMIN_PASSWORD_CHECK),
		accessTokenPayload,
	});

	if (decision.relay) {
		// 命中（头通道有效 -> 清零本窗口失败计数，H3 防误伤后自动恢复）
		if (hasAdminAuth) {
			await clearAdminFailures(c);
		}
		await next();
		return;
	}

	if (decision.recordFailure) {
		await recordAdminFailure(c);
	}

	const msgs = i18n.getMessages(lang);
	let body: string;
	switch (decision.kind) {
		case "rate_limit":
			body = msgs.RateLimitExceededMsg;
			break;
		case "access_token_expired":
			body = msgs.UserAcceesTokenExpiredMsg;
			break;
		case "role_not_admin":
			body = msgs.UserRoleIsNotAdminMsg;
			break;
		default:
			body = msgs.NeedAdminPasswordMsg;
	}
	// 普通用户直接返回 403 禁止访问，不要求提供口令
	const finalStatus = (decision.kind === "role_not_admin") ? 403 : decision.status;
	return c.text(body, finalStatus);
});


app.route('/', commonApi)
app.route('/', openAuthApi)
app.route('/', mailsApi)
app.route('/', userApi)
app.route('/', adminApi)
app.route('/', apiSendMail)
app.route('/', telegramApi)
app.route('/', unifiedApi)

const health_check = async (c: Context<HonoCustomType>) => {
	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;
	const msgs = i18n.getMessages(lang);
	if (!c.env.DB) {
		return c.text(msgs.DBNotAvailableMsg, 400);
	}
	if (!c.env.JWT_SECRET) {
		return c.text(msgs.JWTSecretNotSetMsg, 400);
	}
	if (getDomains(c).length === 0) {
		return c.text(msgs.DomainsNotSetMsg, 400);
	}
	return c.text("OK");
}

app.get('/', health_check)
app.get('/health_check', health_check)
app.all('/*', async c => c.text("Not Found", 404))


export default {
	fetch: app.fetch,
	email: email,
	scheduled: scheduled,
}
