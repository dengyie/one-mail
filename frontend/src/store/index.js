import { computed, ref } from "vue";
import {
    createGlobalState, useStorage, useDark, useToggle,
    useLocalStorage, useSessionStorage
} from '@vueuse/core'

export const useGlobalState = createGlobalState(
    () => {
        // class 策略：<html class="dark"> 才走 dark 主题。这样 Tailwind 的 dark: 变体
        // 与 Naive UI 的 darkTheme 一起切换（awesome-ui 组件依赖 dark: 工具类）。
        const isDark = useDark({
            selector: 'html',
            attribute: 'class',
            valueDark: 'dark',
            valueLight: '',
            storageKey: 'color-scheme',
        })
        const toggleDark = useToggle(isDark)
        const loading = ref(false);
        const announcement = useLocalStorage('announcement', '');
        const useSimpleIndex = useLocalStorage('useSimpleIndex', false);
        const openSettings = ref({
            fetched: false,
            title: '',
            announcement: '',
            alwaysShowAnnouncement: false,
            prefix: '',
            addressRegex: '',
            needAuth: false,
            adminContact: '',
            enableUserCreateEmail: false,
            disableAnonymousUserCreateEmail: false,
            disableCustomAddressName: false,
            enableUserDeleteEmail: false,
            enableAutoReply: false,
            enableIndexAbout: false,
            /** @type {string[]} */
            defaultDomains: [],
            /** @type {string[]} */
            randomSubdomainDomains: [],
            /** @type {Array<{label: string, value: string}>} */
            domains: [],
            copyright: 'Dream Hunter',
            cfTurnstileSiteKey: '',
            enableWebhook: false,
            isS3Enabled: false,
            enableSendMail: false,
            showGithub: true,
            showGithubForUser: true,
            disableAdminPasswordCheck: false,
            enableAddressPassword: false,
            enableAgentEmailInfo: false,
            smtpImapProxyConfig: {
                smtp: {
                    host: '',
                    port: 8025,
                    starttls: false,
                },
                imap: {
                    host: '',
                    port: 11143,
                    starttls: false,
                },
            },
            statusUrl: '',
            enableGlobalTurnstileCheck: false,
        })
        const settings = ref({
            fetched: false,
            send_balance: 0,
            address: '',
            auto_reply: {
                subject: '',
                message: '',
                enabled: false,
                source_prefix: '',
                name: '',
            }
        });
        const sendMailModel = useSessionStorage('sendMailModel', {
            fromName: "",
            toName: "",
            toMail: "",
            subject: "",
            contentType: 'text',
            content: "",
        });
        const showAuth = ref(false);
        const showAddressCredential = ref(false);
        const showAdminAuth = ref(false);
        // 统一收件箱（/api/unified/*）的 Bearer API-key，localStorage 持久化
        const unifiedApiKey = useLocalStorage('unifiedApiKey', '');
        const auth = useStorage('auth', '');
        const adminAuth = useStorage('adminAuth', '');
        const jwt = useStorage('jwt', '');
        const addressPassword = useSessionStorage('addressPassword', '');
        const adminTab = useSessionStorage('adminTab', "account");
        const adminMailTabAddress = ref("");
        const adminSendBoxTabAddress = ref("");
        const mailboxSplitSize = useStorage('mailboxSplitSize', 0.25);
        const mailListView = useStorage('mailListView', false);
        const mailListPreviewLineClamp = useStorage('mailListPreviewLineClamp', 2);
        const useIframeShowMail = useStorage('useIframeShowMail', false);
        const preferShowTextMail = useStorage('preferShowTextMail', false);
        const userJwt = useStorage('userJwt', '');
        const preferredLocale = useStorage('preferredLocale', '');
        const userTab = useSessionStorage('userTab', 'address_management');
        const globalTabplacement = useStorage('globalTabplacement', 'top');
        const useSideMargin = useStorage('useSideMargin', true);
        const useUTCDate = useStorage('useUTCDate', false);
        const autoLoadRemoteImages = useStorage('autoLoadRemoteImages', false);
        const autoRefresh = useStorage('autoRefresh', false);
        const configAutoRefreshInterval = useStorage("configAutoRefreshInterval", 60);
        const userOpenSettings = ref({
            fetched: false,
            enable: false,
            enableMailVerify: false,
            /** @type {{ clientID: string, name: string, icon?: string }[]} */
            oauth2ClientIDs: [],
        });
        const userSettings = ref({
            /** @type {boolean} */
            fetched: false,
            /** @type {string} */
            user_email: '',
            /** @type {number} */
            user_id: 0,
            /** @type {boolean} */
            is_admin: false,
            /** @type {string | null} */
            access_token: null,
            /** @type {string | null} */
            new_user_token: null,
            /** @type {null | {domains: string[] | undefined | null, role: string, prefix: string | undefined | null}} */
            user_role: null,
        });
        // 管理面板可见性：后端告知的策略信号（adminAuth=已输管理密码；is_admin=角色；disableAdminPasswordCheck=后端开关）。
        // 表达式集中于一处，避免多处重演（架构重构 P8）；`=== true` 为显式比较，语义与原 truthy 判断等价。
        const showAdminPage = computed(() =>
            !!adminAuth.value
            || userSettings.value.is_admin === true
            || openSettings.value.disableAdminPasswordCheck === true
        );
        // 当前管理登录方式（单源判定，供组件消费）：与 showAdminPage 同一策略三源、同一严格比较语义。
        // adminAuth（已输管理密码）→ 'admin'；is_admin === true → 'user_admin'；disableAdminPasswordCheck === true → 'disabled_check'；否则 ''。
        const adminLoginMode = computed(() =>
            adminAuth.value
            ? 'admin'
            : userSettings.value.is_admin === true
                ? 'user_admin'
                : openSettings.value.disableAdminPasswordCheck === true
                    ? 'disabled_check'
                    : ''
        );
        const telegramApp = ref(window.Telegram?.WebApp || {});
        const isTelegram = ref(!!window.Telegram?.WebApp?.initData);
        const _oauth2StateSession = useSessionStorage('userOauth2SessionState', '');
        const _oauth2StateFallback = useStorage('userOauth2SessionState_fb', '');
        const userOauth2SessionState = computed({
            get: () => _oauth2StateSession.value || _oauth2StateFallback.value,
            set: (v) => { _oauth2StateSession.value = v; _oauth2StateFallback.value = v; }
        });
        const _oauth2ClientIDSession = useSessionStorage('userOauth2SessionClientID', '');
        const _oauth2ClientIDFallback = useStorage('userOauth2SessionClientID_fb', '');
        const userOauth2SessionClientID = computed({
            get: () => _oauth2ClientIDSession.value || _oauth2ClientIDFallback.value,
            set: (v) => { _oauth2ClientIDSession.value = v; _oauth2ClientIDFallback.value = v; }
        });
        const browserFingerprint = ref('');
        return {
            isDark,
            toggleDark,
            loading,
            settings,
            sendMailModel,
            announcement,
            openSettings,
            showAuth,
            showAddressCredential,
            auth,
            jwt,
            adminAuth,
            unifiedApiKey,
            showAdminAuth,
            adminTab,
            adminMailTabAddress,
            adminSendBoxTabAddress,
            mailboxSplitSize,
            mailListView,
            mailListPreviewLineClamp,
            useIframeShowMail,
            preferShowTextMail,
            userJwt,
            preferredLocale,
            userTab,
            userOpenSettings,
            userSettings,
            globalTabplacement,
            useSideMargin,
            useUTCDate,
            autoLoadRemoteImages,
            autoRefresh,
            configAutoRefreshInterval,
            telegramApp,
            isTelegram,
            showAdminPage,
            adminLoginMode,
            userOauth2SessionState,
            userOauth2SessionClientID,
            useSimpleIndex,
            addressPassword,
            browserFingerprint,
        }
    },
)
