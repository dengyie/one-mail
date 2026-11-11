import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

// Only the error-message mapper is under test; the mail runtime behind
// send_mail.ts is stubbed out (send_mail_api.ts value-imports a type-only
// export of core/outbound_mail, which node's type-stripping cannot link).
const stubs = {
    "../mails_api/send_mail_api":
        "export const sendMail=async()=>{throw new Error('unexpected sendMail')};" +
        "export const enqueueExternalSend=async()=>{};" +
        "export const resolveGmailReplyTarget=async()=>{};" +
        "export const saveSendbox=async()=>{};" +
        "export const saveSendboxIfMissing=async()=>{};",
    "../common": "export const isSendMailBindingEnabled=async()=>false;",
    "../utils": "export const getMailDomain=(mail)=>String(mail).split('@')[1]??'';",
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL?.endsWith("/admin_api/send_mail.ts") && stubs[specifier]) {
            return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
        }
        try { return next(specifier, context); }
        catch (cause) {
            if (!specifier.startsWith(".")) throw cause;
            for (const suffix of [".ts", "/index.ts"]) {
                const target = new URL(specifier + suffix, context.parentURL);
                if (existsSync(target)) return next(target.href, context);
            }
            throw cause;
        }
    },
});
const i18n = (await import("../i18n/index.ts")).default;
const { getAdminSendMailErrorMessage } = await import("./send_mail.ts");
const { SendMailDeliveryUnknownError, SendMailIdempotencyConflictError } =
    await import("../mails_api/send_mail_limit_utils.ts");
hooks.deregister();

const msgs = i18n.getMessages(null);

test("exact i18n message passes through", () => {
    assert.equal(getAdminSendMailErrorMessage(msgs, new Error(msgs.InvalidDomainMsg)), msgs.InvalidDomainMsg);
});

test("i18n message with operator suffix passes through (2026-11-12 production feedback)", () => {
    // sendMail throws EnableResendOrSmtpOrSendMailMsg + " (" + domain + ")";
    // the old exact-match mapper swallowed the reason into a generic failure.
    const thrown = `${msgs.EnableResendOrSmtpOrSendMailMsg} (dengyie.tech)`;
    assert.equal(getAdminSendMailErrorMessage(msgs, new Error(thrown)), thrown);

    const smtp = `${msgs.InvalidSmtpConfigMsg}: bad port`;
    assert.equal(getAdminSendMailErrorMessage(msgs, new Error(smtp)), smtp);
});

test("unknown internal message stays masked", () => {
    assert.equal(getAdminSendMailErrorMessage(msgs, new Error("D1_ERROR: internal stuff")), msgs.OperationFailedMsg);
    assert.equal(getAdminSendMailErrorMessage(msgs, "not an error"), msgs.OperationFailedMsg);
});

test("typed delivery/idempotency errors pass their curated message", () => {
    assert.equal(getAdminSendMailErrorMessage(msgs, new SendMailDeliveryUnknownError()),
        "Mail delivery status is unknown; reuse the same idempotency key to query the result.");
    assert.equal(getAdminSendMailErrorMessage(msgs, new SendMailIdempotencyConflictError()),
        "The idempotency key was already used for a different request.");
});
