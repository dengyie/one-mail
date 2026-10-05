/**
 * Outbound send-mail channel resolution (domain-split Resend / SMTP / binding).
 *
 * node --test loads this module directly, so it has zero imports.
 *
 * Global `RESEND_TOKEN` used to win for every domain and hide SMTP_CONFIG.
 * Per-domain Resend and per-domain SMTP now beat the global token, so one
 * domain can use Resend while others use generic SMTP on the same Worker.
 */

export type SendMailChannelKind = "resend" | "smtp" | "binding" | "none";

export type SendMailChannel<TSmtp = unknown> =
    | { kind: "resend"; token: string; source: "domain" | "global" }
    | { kind: "smtp"; options: TSmtp }
    | { kind: "binding" }
    | { kind: "none" };

const nonemptyToken = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const resendTokenEnvKey = (mailDomain: string): string => {
    return `RESEND_TOKEN_${String(mailDomain || "").replace(/\./g, "_").toUpperCase()}`;
};

export const getDomainResendToken = (
    env: { [key: string]: unknown },
    mailDomain: string
): string | null => {
    const value = env[resendTokenEnvKey(mailDomain)];
    return nonemptyToken(typeof value === "string" ? value : null);
};

/**
 * Provider order after the verified-address binding shortcut:
 * 1. RESEND_TOKEN_<DOMAIN>
 * 2. SMTP_CONFIG[domain]
 * 3. global RESEND_TOKEN
 * 4. SEND_MAIL binding
 */
export const resolveSendMailChannel = <TSmtp>(input: {
    domainResendToken?: string | null;
    globalResendToken?: string | null;
    smtpConfig?: TSmtp | null;
    sendMailBindingEnabled: boolean;
}): SendMailChannel<TSmtp> => {
    const domainToken = nonemptyToken(input.domainResendToken);
    if (domainToken) {
        return { kind: "resend", token: domainToken, source: "domain" };
    }
    if (input.smtpConfig != null) {
        return { kind: "smtp", options: input.smtpConfig };
    }
    const globalToken = nonemptyToken(input.globalResendToken);
    if (globalToken) {
        return { kind: "resend", token: globalToken, source: "global" };
    }
    if (input.sendMailBindingEnabled) {
        return { kind: "binding" };
    }
    return { kind: "none" };
};
