import { Context } from "hono";
import { isSendMailBindingEnabled } from "../common";
import i18n from "../i18n";
import { sendMail } from "../mails_api/send_mail_api";
import { reserveSendMailLimit, type SendMailLimitReservation, hashSendMailRequest, SendMailDeliveryUnknownError, SendMailIdempotencyConflictError } from "../mails_api/send_mail_limit_utils";
import { getMailDomain } from "../utils";

const getAdminSendMailErrorMessage = (
    msgs: ReturnType<typeof i18n.getMessagesbyContext>,
    error: unknown
): string => {
    const message = error instanceof Error ? error.message : "";
    return Object.values(msgs).includes(message)
        ? message
        : msgs.OperationFailedMsg;
}

export const sendMailbyAdmin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    let reqJson;
    try {
        reqJson = await c.req.json();
    } catch (e) {
        console.error("Admin send_mail invalid json", e);
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const {
        from_name, from_mail,
        to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    try {
        await sendMail(c, from_mail, {
            from_name: from_name,
            to_name: to_name,
            to_mail: to_mail,
            subject: subject,
            content: content,
            is_html: is_html,
        }, {
            isAdmin: true,
            idempotencyKey: c.req.raw.headers.get("x-idempotency-key") ?? undefined
        })
    } catch (e) {
        console.error("Admin send_mail failed", e);
        return c.text(getAdminSendMailErrorMessage(msgs, e), 400)
    }
    return c.json({ status: "ok" });
}

export const sendMailByBindingAdmin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.SEND_MAIL) {
        return c.text(msgs.EnableSendMailMsg, 400)
    }
    let reqJson;
    try {
        reqJson = await c.req.json();
    } catch (e) {
        console.error("Admin raw send_mail invalid json", e);
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const {
        from, to, subject,
        html, text,
        cc, bcc, replyTo,
        attachments, headers,
    } = reqJson;
    if (!from || !to || !subject || (!html && !text)) {
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const fromMail = typeof from === "string" ? from : from?.email;
    const mailDomain = getMailDomain(fromMail);
    if (!mailDomain) {
        return c.text(msgs.InvalidInputMsg, 400)
    }
    if (!isSendMailBindingEnabled(c, mailDomain)) {
        return c.text(msgs.EnableSendMailForDomainMsg, 400)
    }
    let sendMailLimitReservation: SendMailLimitReservation | null = null;
    let providerDispatchStarted = false;
    try {
        const idempotencyKey = c.req.raw.headers.get("x-idempotency-key") ?? undefined;
        const requestHash = idempotencyKey ? await hashSendMailRequest({ from, to, subject, html, text, cc, bcc, replyTo, attachments, headers }) : undefined;
        sendMailLimitReservation = await reserveSendMailLimit(c, { idempotencyKey, requestHash });
        if (sendMailLimitReservation?.replay === "sent") return c.json({ status: "ok" });
        if (sendMailLimitReservation?.replay === "unknown") throw new SendMailDeliveryUnknownError();
        if (sendMailLimitReservation) {
            await sendMailLimitReservation.markDispatchStarted();
            providerDispatchStarted = true;
        }
        await c.env.SEND_MAIL.send({
            from,
            to,
            subject,
            ...(html ? { html } : {}),
            ...(text ? { text } : {}),
            ...(cc ? { cc } : {}),
            ...(bcc ? { bcc } : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(attachments && attachments.length ? { attachments } : {}),
            ...(headers ? { headers } : {}),
        });
        if (sendMailLimitReservation) await sendMailLimitReservation.markDispatchSucceeded();
    } catch (e) {
        if (providerDispatchStarted) {
            console.error("Admin provider dispatch outcome is unknown", e);
            return c.text(new SendMailDeliveryUnknownError().message, 503)
        }
        if (sendMailLimitReservation) {
            try { await sendMailLimitReservation.release(); }
            catch (releaseError) { console.error("Failed to release send mail limit reservation", releaseError); }
        }
        console.error("Admin raw send_mail failed", e);
        const status = e instanceof SendMailIdempotencyConflictError ? 409 : 400;
        return c.text(getAdminSendMailErrorMessage(msgs, e), status as 400 | 409)
    }
    if (sendMailLimitReservation) {
        try { await sendMailLimitReservation.commit(); }
        catch (commitError) {
            console.error("Failed to commit send mail limit reservation; reconciliation will promote sent state", commitError);
        }
    }
    return c.json({ status: "ok" });
}
