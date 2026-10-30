import { Context } from "hono";
import { isSendMailBindingEnabled } from "../common";
import i18n from "../i18n";
import { enqueueExternalSend, loadOriginalMail, saveSendbox, saveSendboxIfMissing, sendMail } from "../mails_api/send_mail_api";
import { reserveSendMailLimit, type SendMailLimitReservation, hashSendMailRequest, SendMailDeliveryUnknownError, SendMailIdempotencyConflictError, listUnknownSendMailReservations, countUnknownSendMailReservations, resolveUnknownSendMailReservation, refundResolvedSendMailBalance } from "../mails_api/send_mail_limit_utils";
import { singleHeaderValue } from "../core/send_guard";
import { GMAIL_THREAD_RE } from "../core/outbound_mail";
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
            idempotencyKey: c.req.raw.headers.get("x-idempotency-key") ?? undefined,
            source: "admin",
        })
    } catch (e) {
        console.error("Admin send_mail failed", e);
        const status = e instanceof SendMailDeliveryUnknownError ? 503 : e instanceof SendMailIdempotencyConflictError ? 409 : 400;
        return c.text(getAdminSendMailErrorMessage(msgs, e), status as 400 | 409 | 503)
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
        if (sendMailLimitReservation?.replay === "sent") {
            const toMail = Array.isArray(to)
                ? (typeof to[0] === "string" ? to[0] : to[0]?.email)
                : (typeof to === "string" ? to : to?.email);
            await saveSendboxIfMissing(c, fromMail, {
                from_name: typeof from === "string" ? "" : (from?.name || ""),
                to_name: "",
                to_mail: toMail,
                subject,
                is_html: Boolean(html),
                content: html || text || "",
            }, {
                source: "admin_binding",
                channel: "binding",
                reservation_id: sendMailLimitReservation.id ?? null,
            });
            return c.json({ status: "ok" });
        }
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
    const toMail = Array.isArray(to)
        ? (typeof to[0] === "string" ? to[0] : to[0]?.email)
        : (typeof to === "string" ? to : to?.email);
    await saveSendbox(c, fromMail, {
        from_name: typeof from === "string" ? "" : (from?.name || ""),
        to_name: "",
        to_mail: toMail,
        subject,
        is_html: Boolean(html),
        content: html || text || "",
    }, {
        source: "admin_binding",
        channel: "binding",
        reservation_id: sendMailLimitReservation?.id ?? null,
    });
    return c.json({ status: "ok" });
}


type AdminGmailReplyAccount = {
    id: string;
    user_id: number;
    username: string;
};

/**
 * POST /admin/send_mail/gmail_reply
 *
 * Program callers authenticate with x-admin-auth, so there is no user payload to
 * scope a reply against. The sending identity is derived from the original mail
 * row: only an enabled, sendable Gmail account may be used, and any account_id or
 * from address in the request is ignored. Routing itself stays inside
 * enqueueExternalSend, which re-checks ownership against the account's user and
 * forces the Gmail thread on the same terms as the login-user branch.
 */
export const sendGmailReplyByAdmin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    let reqJson: Record<string, unknown>;
    try {
        const body = await c.req.json();
        reqJson = body !== null && typeof body === "object" && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
    } catch (e) {
        console.error("Admin gmail reply invalid json", e);
        return c.text(msgs.InvalidInputMsg, 400);
    }
    const replyToEmailId = typeof reqJson.reply_to_email_id === "string" ? reqJson.reply_to_email_id.trim() : "";
    if (!replyToEmailId) {
        return c.text("reply_to_email_id is required", 400);
    }

    const original = await loadOriginalMail(c, replyToEmailId);
    if (!original?.account_id) {
        return c.text("original mail not found", 400);
    }
    if (original.source !== "imap_gmail") {
        return c.text("original mail is not a Gmail message", 400);
    }

    const account = await c.env.DB.prepare(
        `SELECT id, user_id, username FROM user_mail_accounts
          WHERE id = ? AND source = 'imap_gmail' AND enabled = 1 AND can_send = 1`,
    ).bind(original.account_id).first<AdminGmailReplyAccount>();
    if (!account?.username) {
        return c.text(msgs.ExternalAccountCannotSendMsg, 403);
    }

    const storedThread = original.provider_thread_id?.trim().toLowerCase() ?? "";
    const threadId = GMAIL_THREAD_RE.test(storedThread) ? storedThread : undefined;
    const messageId = singleHeaderValue(original.message_id_header);
    const references = Array.isArray(reqJson.references)
        ? reqJson.references.filter((value): value is string => typeof value === "string")
        : [];
    const idempotencyKey = c.req.raw.headers.get("x-idempotency-key")?.trim() || "";
    try {
        return await enqueueExternalSend(c, account.user_id, {
            account_id: account.id,
            from_addr: account.username,
            from_name: typeof reqJson.from_name === "string" ? reqJson.from_name : "",
            to_mail: reqJson.to_mail,
            to_name: typeof reqJson.to_name === "string" ? reqJson.to_name : "",
            subject: reqJson.subject,
            content: reqJson.content,
            // Left as-is when present so a non-boolean is rejected by payload
            // validation instead of silently becoming plain text.
            is_html: reqJson.is_html === undefined ? false : reqJson.is_html,
            reply_to_email_id: replyToEmailId,
            ...(messageId ? { in_reply_to: messageId } : {}),
            ...(references.length > 0 ? { references } : {}),
            ...(threadId ? { provider_thread_id: threadId } : {}),
        }, idempotencyKey ? {
            idempotencyKey,
            requestHash: await hashSendMailRequest({ route: "admin_gmail_reply", user_id: account.user_id, reqJson }),
        } : undefined);
    } catch (e) {
        if (e instanceof SendMailIdempotencyConflictError) {
            return c.text(e.message, 409);
        }
        console.error("Admin gmail reply failed", e);
        throw e;
    }
};


export const listUnknownSendMail = async (c: Context<HonoCustomType>) => {
    try {
        const rawLimit = Number(c.req.query("limit") || 100);
        const [results, count] = await Promise.all([
            listUnknownSendMailReservations(c.env.DB, Number.isFinite(rawLimit) ? rawLimit : 100),
            countUnknownSendMailReservations(c.env.DB),
        ]);
        return c.json({ results, count });
    } catch (error) {
        console.error("Failed to list unknown send-mail reservations", error);
        return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 500);
    }
};

export const resolveUnknownSendMail = async (c: Context<HonoCustomType>) => {
    const { id } = c.req.param();
    let body: { outcome?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.text(i18n.getMessagesbyContext(c).InvalidInputMsg, 400);
    }
    if (body.outcome !== "sent" && body.outcome !== "rejected") {
        return c.text(i18n.getMessagesbyContext(c).InvalidInputMsg, 400);
    }
    try {
        const result = await resolveUnknownSendMailReservation(c, id, body.outcome);
        if (result.status === "not_found") return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 404);
        if (result.status === "already_resolved") return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 409);
        if (result.refundAddress) {
            try {
                const refunded = result.refundAddressId !== undefined
                    && await refundResolvedSendMailBalance(c, id, result.refundAddress, result.refundAddressId);
                if (!refunded) {
                    console.error("Unknown delivery was released but balance refund was not applied");
                    return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 500);
                }
            } catch (error) {
                console.error("Unknown delivery was released but balance refund failed", error);
                return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 500);
            }
        }
        return c.json({ status: result.status });
    } catch (error) {
        console.error("Failed to resolve unknown send-mail reservation", error);
        return c.text(i18n.getMessagesbyContext(c).OperationFailedMsg, 500);
    }
};
