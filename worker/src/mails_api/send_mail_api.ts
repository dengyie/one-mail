import { Context, Hono } from 'hono'
import { verifyActiveAddressJwt } from '../core/auth'
import { createMimeMessage } from 'mimetext';
import { Resend } from 'resend';
import { WorkerMailer, WorkerMailerOptions } from 'worker-mailer';

import i18n from '../i18n';
import { CONSTANTS } from '../constants'
import { getJsonSetting, getDomains, getBooleanValue, getJsonObjectValue, getDomainMapValue, getMailDomain, includesDomain } from '../utils';
import { GeoData } from '../models'
import { handleListQuery, isSendMailBindingEnabled, updateAddressUpdatedAt } from '../common'
import { getDomainResendToken, resolveSendMailChannel } from '../core/send_mail_channel';
import {
    buildSendboxListFilter,
    buildSendboxRaw,
    decorateSendboxRow,
    persistChannelFromDispatch,
    resolveSendMailSource,
    type SendMailSource,
} from '../core/sendbox_source';
import { getSendBalanceState, requestSendMailAccess, reserveSendBalance, refundSendBalance } from './send_balance';
import { reserveSendMailLimit, type SendMailLimitReservation, hashSendMailRequest, SendMailDeliveryUnknownError, SendMailIdempotencyConflictError } from './send_mail_limit_utils';


export const api = new Hono<HonoCustomType>()

api.post('/api/request_send_mail_access', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.text(msgs.AddressNotFoundMsg, 400)
    }
    const result = await requestSendMailAccess(c, address);
    if (result.status === "ok") {
        return c.json({ status: "ok" })
    }
    if (result.status === "already_requested") {
        return c.text(msgs.AlreadyRequestedMsg, 400)
    }
    return c.text(msgs.OperationFailedMsg, 500)
})

export const sendMailToVerifyAddress = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    }
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    const msg = createMimeMessage();
    msg.setSender(from_name ? { name: from_name, addr: address } : address);
    msg.setRecipient(to_name ? { name: to_name, addr: to_mail } : to_mail);
    msg.setSubject(subject);
    msg.addMessage({
        contentType: is_html ? 'text/html' : 'text/plain',
        data: content
    });
    const { EmailMessage } = await import('cloudflare:email');
    const message = new EmailMessage(address, to_mail, msg.asRaw());
    await c.env.SEND_MAIL.send(message);
}

export const sendMailByBinding = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    }
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    await c.env.SEND_MAIL.send({
        from: from_name ? { email: address, name: from_name } : address,
        to: to_name ? [`${to_name} <${to_mail}>`] : [to_mail],
        subject,
        ...(is_html ? { html: content } : { text: content }),
    });
}

const sendMailByResend = async (
    address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    },
    token: string
): Promise<string | undefined> => {
    const resend = new Resend(token);
    const { data, error } = await resend.emails.send({
        from: reqJson.from_name ? `${reqJson.from_name} <${address}>` : address,
        to: reqJson.to_name ? `${reqJson.to_name} <${reqJson.to_mail}>` : reqJson.to_mail,
        subject: reqJson.subject,
        ...(reqJson.is_html ? {
            html: reqJson.content,
        } : {
            text: reqJson.content,
        })
    });
    if (error) {
        throw new Error(`Resend error: ${error.name} ${error.message}`);
    }
    console.log(`Resend success: ${JSON.stringify(data)}`);
    return data?.id;
}

const sendMailBySmtp = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    },
    smtpOptions: WorkerMailerOptions
): Promise<void> => {
    await WorkerMailer.send(
        smtpOptions,
        {
            from: {
                name: reqJson.from_name,
                email: address
            },
            to: {
                name: reqJson.to_name,
                email: reqJson.to_mail
            },
            subject: reqJson.subject,
            text: reqJson.is_html ? undefined : reqJson.content,
            html: reqJson.is_html ? reqJson.content : undefined
        }
    )
}

export const sendMail = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    },
    options?: {
        isAdmin?: boolean
        addressId?: number | string
        idempotencyKey?: string
        source?: SendMailSource
    }
): Promise<void> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!address) {
        throw new Error(msgs.AddressNotFoundMsg)
    }
    // A credential must still point at the same address row at dispatch time.
    // This closes the delete/recreate race between middleware and provider send.
    if (options?.addressId !== undefined && options?.addressId !== null) {
        const activeAddress = await c.env.DB.prepare(
            `SELECT id FROM address WHERE id = ? AND name = ?`
        ).bind(options.addressId, address).first();
        if (!activeAddress) {
            throw new Error(msgs.AddressNotFoundMsg)
        }
    }
    // check domain
    const mailDomain = getMailDomain(address);
    const domains = getDomains(c);
    if (!includesDomain(domains, mailDomain)) {
        throw new Error(msgs.InvalidDomainMsg)
    }
    const sendBalanceState = await getSendBalanceState(c, address, {
        isAdmin: options?.isAdmin,
    });
    let balanceReserved = false;
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    if (!to_mail) {
        throw new Error(msgs.InvalidToMailMsg)
    }
    // check SEND_BLOCK_LIST_KEY
    const sendBlockList = await getJsonSetting(c, CONSTANTS.SEND_BLOCK_LIST_KEY) as string[];
    if (sendBlockList && sendBlockList.some((item) => to_mail.includes(item))) {
        throw new Error(msgs.AddressBlockedMsg)
    }
    if (!subject) {
        throw new Error(msgs.SubjectEmptyMsg)
    }
    if (!content) {
        throw new Error(msgs.ContentEmptyMsg)
    }
    // Resolve the dispatch path before taking any reservations. The actual provider
    // call stays inside one try/catch so every failed attempt releases both quotas.
    const smtpConfigMap = getJsonObjectValue<Record<string, WorkerMailerOptions>>(c.env.SMTP_CONFIG);
    const channel = resolveSendMailChannel<WorkerMailerOptions>({
        domainResendToken: getDomainResendToken(c.env, mailDomain),
        globalResendToken: c.env.RESEND_TOKEN,
        smtpConfig: getDomainMapValue(smtpConfigMap, mailDomain),
        sendMailBindingEnabled: isSendMailBindingEnabled(c, mailDomain),
    });
    const verifiedAddressList = c.env.SEND_MAIL
        ? await getJsonSetting(c, CONSTANTS.VERIFIED_ADDRESS_LIST_KEY) || []
        : [];
    const sendByVerifiedAddressList = verifiedAddressList.includes(to_mail);
    let sendMailLimitReservation: SendMailLimitReservation | null = null;
    let providerDispatchStarted = false;
    let providerMessageId: string | undefined;

    // Reserve the server quota and sender balance immediately before dispatch.
    try {
        const idempotencyKey = options?.idempotencyKey;
        const requestHash = idempotencyKey ? await hashSendMailRequest({ address, reqJson }) : undefined;
        sendMailLimitReservation = await reserveSendMailLimit(c, { idempotencyKey, requestHash });
        if (sendMailLimitReservation?.replay === "sent") {
            await saveSendboxIfMissing(c, address, reqJson as unknown as Record<string, unknown>, {
                source: resolveSendMailSource({
                    explicit: options?.source,
                    path: c.req.path,
                    header: c.req.raw.headers.get("x-one-mail-client"),
                }),
                ...persistChannelFromDispatch({ sendByVerifiedAddressList, channel }),
                reservation_id: sendMailLimitReservation.id ?? null,
            });
            return;
        }
        if (sendMailLimitReservation?.replay === "unknown") throw new SendMailDeliveryUnknownError();
        // Verified recipients are free; reserve balance only for billable sends.
        if (!sendByVerifiedAddressList && sendBalanceState.needCheckBalance) {
            balanceReserved = await reserveSendBalance(c, address);
            if (!balanceReserved) {
                throw new Error(msgs.NoBalanceMsg);
            }
            if (sendMailLimitReservation) {
                await sendMailLimitReservation.markBalanceReserved(address, options?.addressId ?? "");
            }
        }

        // Validate that a provider is configured before marking the attempt
        // unknown; a configuration error never touched an external service.
        if (!sendByVerifiedAddressList && channel.kind === "none") {
            throw new Error(msgs.EnableResendOrSmtpOrSendMailMsg + " (" + mailDomain + ")");
        }
        if (sendMailLimitReservation) {
            await sendMailLimitReservation.markDispatchStarted();
            providerDispatchStarted = true;
        }
        if (sendByVerifiedAddressList) {
            await sendMailToVerifyAddress(c, address, reqJson);
        } else if (channel.kind === "resend") {
            providerMessageId = await sendMailByResend(address, reqJson, channel.token);
        } else if (channel.kind === "smtp") {
            await sendMailBySmtp(c, address, reqJson, channel.options);
        } else if (channel.kind === "binding") {
            await sendMailByBinding(c, address, reqJson);
        } else {
            throw new Error(msgs.EnableResendOrSmtpOrSendMailMsg + " (" + mailDomain + ")");
        }
        if (sendMailLimitReservation) await sendMailLimitReservation.markDispatchSucceeded();
    } catch (error) {
        if (providerDispatchStarted) {
            console.error("Provider dispatch outcome is unknown", error);
            throw new SendMailDeliveryUnknownError();
        }
        if (sendMailLimitReservation) {
            try { await sendMailLimitReservation.release(); }
            catch (releaseError) { console.error("Failed to release send mail limit reservation", releaseError); }
        }
        if (balanceReserved) {
            try { await refundSendBalance(c, address); }
            catch (refundError) { console.error("Failed to refund send balance", refundError); }
        }
        throw error;
    }

    // The provider has accepted the message. A commit failure leaves a durable
    // sent marker; the scheduled reconciler promotes it without releasing quota.
    if (sendMailLimitReservation) {
        try {
            await sendMailLimitReservation.commit();
        } catch (commitError) {
            console.error(
                "Failed to commit send mail limit reservation; reconciliation will promote sent state",
                commitError
            );
        }
    }
    // update address updated_at
    updateAddressUpdatedAt(c, address);
    const persist = persistChannelFromDispatch({
        sendByVerifiedAddressList,
        channel,
    });
    const source = resolveSendMailSource({
        explicit: options?.source,
        path: c.req.path,
        header: c.req.raw.headers.get("x-one-mail-client"),
    });
    await saveSendbox(c, address, reqJson as unknown as Record<string, unknown>, {
        source,
        channel: persist.channel,
        channel_source: persist.channel_source,
        provider_message_id: providerMessageId,
        reservation_id: sendMailLimitReservation?.id ?? null,
    });
}

export const saveSendbox = async (
    c: Context<HonoCustomType>,
    address: string,
    reqJson: Record<string, unknown>,
    extra: {
        source: SendMailSource
        channel?: ReturnType<typeof persistChannelFromDispatch>["channel"]
        channel_source?: "domain" | "global"
        provider_message_id?: string | null
        reservation_id?: string | number | null
    }
): Promise<void> => {
    try {
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const body = buildSendboxRaw({
            reqJson,
            geoData,
            source: extra.source,
            channel: extra.channel,
            channel_source: extra.channel_source,
            provider_message_id: extra.provider_message_id,
            reservation_id: extra.reservation_id,
            status: "sent",
        });
        const raw = JSON.stringify(body);
        try {
            const { success } = await c.env.DB.prepare(
                `INSERT INTO sendbox (address, raw, source, channel, provider_message_id) VALUES (?, ?, ?, ?, ?)`
            ).bind(
                address,
                raw,
                extra.source,
                extra.channel ?? null,
                extra.provider_message_id ?? null,
            ).run();
            if (!success) {
                console.warn(`Failed to save to sendbox for ${address}`);
            }
        } catch (e) {
            console.warn(`Failed to save to sendbox for ${address}`, e);
            const message = e instanceof Error ? e.message : String(e);
            if (!/no such column|has no column named/i.test(message)) {
                return;
            }
            // Pre-migration D1 still has the 3-column sendbox. History must still land.
            const { success } = await c.env.DB.prepare(
                `INSERT INTO sendbox (address, raw) VALUES (?, ?)`
            ).bind(address, raw).run();
            if (!success) {
                console.warn(`Failed to save fallback sendbox for ${address}`);
            }
        }
    } catch (e) {
        console.warn(`Failed to save to sendbox for ${address}`, e);
    }
}

export const saveSendboxIfMissing = async (
    c: Context<HonoCustomType>,
    address: string,
    reqJson: Record<string, unknown>,
    extra: Parameters<typeof saveSendbox>[3],
): Promise<void> => {
    const reservationId = extra.reservation_id;
    if (reservationId !== undefined && reservationId !== null && reservationId !== "") {
        try {
            const existing = await c.env.DB.prepare(
                `SELECT id FROM sendbox WHERE address = ? AND json_extract(raw, '$.reservation_id') = ? LIMIT 1`
            ).bind(address, String(reservationId)).first();
            if (existing) {
                return;
            }
        } catch (e) {
            console.warn(`Failed to look up sendbox on sent replay for ${address}`, e);
        }
    }
    await saveSendbox(c, address, reqJson, extra);
}

api.post('/api/send_mail', async (c) => {
    const { address, address_id } = c.get("jwtPayload")
    const reqJson = await c.req.json();
    try {
        await sendMail(c, address, reqJson, {
            addressId: address_id,
            idempotencyKey: c.req.raw.headers.get("x-idempotency-key") ?? undefined,
            source: resolveSendMailSource({
                path: "/api/send_mail",
                header: c.req.raw.headers.get("x-one-mail-client"),
            }),
        });
    } catch (e) {
        console.error("Failed to send mail", e);
        const error = e as Error & { status?: number };
        const status = error instanceof SendMailDeliveryUnknownError ? 503 : error instanceof SendMailIdempotencyConflictError ? 409 : 400;
        return c.text(`Failed to send mail ${error.message}`, status as 400 | 409 | 503)
    }
    return c.json({ status: "ok" })
})

api.post('/external/api/send_mail', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    try {
        const body = await c.req.json();
        const { token, ...reqJson } = body;
        const payload = await verifyActiveAddressJwt(c, token);
        if (!payload) {
            throw new Error(msgs.AddressNotFoundMsg);
        }
        const { address } = payload;
        await sendMail(c, address, reqJson, {
            addressId: payload.address_id,
            idempotencyKey: c.req.raw.headers.get("x-idempotency-key") ?? undefined,
            source: resolveSendMailSource({
                path: "/external/api/send_mail",
                header: c.req.raw.headers.get("x-one-mail-client"),
            }),
        });
        return c.json({ status: "ok" })
    } catch (e) {
        console.error("Failed to send mail", e);
        const error = e as Error & { status?: number };
        const status = error instanceof SendMailDeliveryUnknownError ? 503 : error instanceof SendMailIdempotencyConflictError ? 409 : 400;
        return c.text(`Failed to send mail ${error.message}`, status as 400 | 409 | 503)
    }
})

export const querySendboxList = async (
    c: Context<HonoCustomType>,
    input: {
        address?: string | null
        source?: string | null
        channel?: string | null
        q?: string | null
        from?: string | null
        to?: string | null
        limit: string | undefined
        offset: string | undefined
        withCount?: boolean
    }
): Promise<Response> => {
    const filter = buildSendboxListFilter({
        address: input.address,
        source: input.source,
        channel: input.channel,
        q: input.q,
        from: input.from,
        to: input.to,
    });
    if (filter.empty) {
        return c.json({ results: [], count: input.withCount === false ? null : 0 });
    }
    const response = await handleListQuery(
        c,
        `SELECT * FROM sendbox WHERE ${filter.where} `,
        `SELECT count(*) as count FROM sendbox WHERE ${filter.where} `,
        filter.params as string[],
        input.limit,
        input.offset,
        undefined,
        [],
        { skipCount: input.withCount === false },
    );
    if (response.status !== 200) {
        return response;
    }
    const payload = await response.json() as { results?: Record<string, unknown>[], count?: number | null };
    return c.json({
        results: (payload.results || []).map((row) => decorateSendboxRow(row)),
        count: payload.count === undefined ? 0 : payload.count,
    });
}

export const getSendbox = async (
    c: Context<HonoCustomType>,
    address: string, limit: string, offset: string
): Promise<Response> => {
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    const { source, q, from, to, channel, with_count } = c.req.query();
    return querySendboxList(c, {
        address,
        source,
        channel,
        q,
        from,
        to,
        limit,
        offset,
        withCount: with_count !== "0",
    });
};

api.get('/api/sendbox', async (c) => {
    const { address } = c.get("jwtPayload")
    const { limit, offset } = c.req.query();
    return getSendbox(c, address, limit, offset);
})

api.delete('/api/sendbox/:id', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { id } = c.req.param();
    const { success } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address = ? and id = ? `
    ).bind(address, id).run();
    return c.json({
        success: success
    })
})
