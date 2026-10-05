import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} from '@simplewebauthn/server';

import { Passkey } from '../models';
import type {
    PublicKeyCredentialRequestOptionsJSON,
    PublicKeyCredentialDescriptorJSON,
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import i18n from '../i18n';
import {
    consumePasskeyChallenge,
    resolvePasskeyRpContext,
    storePasskeyChallenge,
} from './passkey_security';

const MAX_PASSKEY_NAME_LENGTH = 255;

type PasskeyRequestBody = {
    credential?: unknown;
    passkey_name?: unknown;
};

type AuthenticateRequestBody = { email?: unknown; credential?: unknown };

type CredentialPayload = Record<string, unknown>;

const asRegistrationResponse = (value: CredentialPayload): RegistrationResponseJSON =>
    value as unknown as RegistrationResponseJSON;

const asAuthenticationResponse = (value: CredentialPayload): AuthenticationResponseJSON =>
    value as unknown as AuthenticationResponseJSON;

const isCredentialPayload = (value: unknown): value is CredentialPayload =>
    !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

const isAuthenticationCredential = (value: unknown): value is CredentialPayload => {
    if (!isCredentialPayload(value)) return false;
    const response = value.response;
    return isNonEmptyString(value.id)
        && value.type === "public-key"
        && isCredentialPayload(response)
        && isNonEmptyString(response.clientDataJSON)
        && isNonEmptyString(response.authenticatorData)
        && isNonEmptyString(response.signature);
};

const normalizePasskeyName = (value: unknown, fallback: string): string | null => {
    if (value == null || value === "") return fallback.slice(0, MAX_PASSKEY_NAME_LENGTH);
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_PASSKEY_NAME_LENGTH) return null;
    return normalized;
};

const verificationFailure = (error: unknown): boolean => {
    if (!(error instanceof Error)) return true;
    const message = error.message.toLowerCase();
    return message.includes("challenge")
        || message.includes("origin")
        || message.includes("rp id")
        || message.includes("credential")
        || message.includes("verification");
};

export default {
    getPassKeys: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const { results } = await c.env.DB.prepare(
            `SELECT passkey_name, passkey_id, created_at, updated_at FROM user_passkeys WHERE user_id = ?`
        ).bind(user.user_id).all<Record<string, string>>();
        return c.json(results);
    },
    renamePassKey: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const user = c.get("userPayload");
        const { passkey_id, passkey_name } = await c.req.json();
        if (!passkey_name || passkey_name.length > 255) {
            return c.text(msgs.InvalidPasskeyNameMsg, 400);
        }
        const { success } = await c.env.DB.prepare(
            `UPDATE user_passkeys SET passkey_name = ? WHERE user_id = ? AND passkey_id = ?`
        ).bind(passkey_name, user.user_id, passkey_id).run();
        return c.json({ success });
    },
    deletePassKey: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const { passkey_id } = c.req.param();
        const { success } = await c.env.DB.prepare(
            `DELETE FROM user_passkeys WHERE user_id = ? AND passkey_id = ?`
        ).bind(user.user_id, passkey_id).run();
        return c.json({ success });
    },
    registerRequest: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const user = c.get("userPayload");
        const rp = resolvePasskeyRpContext(
            c.req.raw.headers.get("Origin"),
            c.env.FRONTEND_URL,
        );
        if (!rp) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        const { results } = await c.env.DB.prepare(
            `SELECT passkey FROM user_passkeys WHERE user_id = ?`
        ).bind(user.user_id).all<Record<string, string>>();
        const excludeCredentials = results
            .map((record: any) => JSON.parse(record.passkey) as Passkey)
            .map((passkey: Passkey) => ({
                id: passkey.id,
                transports: passkey.transports,
            }));

        const options = await generateRegistrationOptions({
            rpName: c.env.TITLE || "Temp Mail",
            rpID: rp.rpID,
            userID: new Uint8Array(new TextEncoder().encode(user.user_id.toString())),
            userName: user.user_email,
            userDisplayName: user.user_email,
            attestationType: 'none',
            authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'required',
            },
            excludeCredentials: excludeCredentials,
            challenge: crypto.randomUUID(),
        });
        if (!(await storePasskeyChallenge(
            c.env,
            "register",
            options.challenge,
            rp,
            user.user_id,
        ))) {
            return c.text(msgs.OperationFailedMsg, 500);
        }

        return c.json(options);
    },
    registerResponse: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const user = c.get("userPayload");
        const body = await c.req.json<PasskeyRequestBody>().catch((): PasskeyRequestBody => ({}));
        const credential = body.credential;
        const passkeyName = normalizePasskeyName(body.passkey_name, `Passkey ${new Date().toISOString().slice(0, 10)}`);
        if (!isCredentialPayload(credential) || !passkeyName) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        const rp = resolvePasskeyRpContext(
            c.req.raw.headers.get("Origin"),
            c.env.FRONTEND_URL,
        );
        if (!rp) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: asRegistrationResponse(credential),
                expectedChallenge: async (challenge: string) =>
                    consumePasskeyChallenge(
                        c.env,
                        "register",
                        challenge,
                        rp,
                        user.user_id,
                    ),
                expectedOrigin: rp.origin,
                expectedRPID: rp.rpID,
                requireUserVerification: true,
            });
        } catch (error) {
            if (verificationFailure(error)) return c.text(msgs.RegistrationFailedMsg, 400);
            throw error;
        }
        const { verified, registrationInfo } = verification;

        if (!verified || !registrationInfo) {
            return c.text(msgs.RegistrationFailedMsg, 400);
        }

        const {
            id: credentialID, publicKey,
            counter, transports,
        } = registrationInfo.credential;
        const { credentialDeviceType: deviceType, credentialBackedUp: backedUp } = registrationInfo;

        const base64PublicKey = isoBase64URL.fromBuffer(publicKey);

        const newPasskey: Passkey = {
            id: credentialID,
            publicKey: base64PublicKey,
            counter,
            deviceType,
            backedUp,
            transports,
        };

        const { success } = await c.env.DB.prepare(
            `INSERT INTO user_passkeys (user_id, passkey_name, passkey_id, passkey, counter) VALUES (?, ?, ?, ?, ?)`
        ).bind(user.user_id, passkeyName, credentialID, JSON.stringify(newPasskey), counter).run();

        return c.json({ success });
    },
    authenticateRequest: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const rp = resolvePasskeyRpContext(
            c.req.raw.headers.get("Origin"),
            c.env.FRONTEND_URL,
        );
        if (!rp) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        let body: AuthenticateRequestBody;
        try {
            body = await c.req.json<AuthenticateRequestBody>();
        } catch {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        let allowCredentials: PublicKeyCredentialDescriptorJSON[] = [];
        let challengeUserId: number | undefined;
        if (email) {
            const account = await c.env.DB.prepare(
                `SELECT id FROM users WHERE lower(user_email) = ?`
            ).bind(email).first<{ id: number }>();
            if (!account) return c.text(msgs.UserNotFoundMsg, 404);
            challengeUserId = account.id;
            const { results } = await c.env.DB.prepare(
                `SELECT passkey_id, passkey FROM user_passkeys WHERE user_id = ?`
            ).bind(account.id).all<{ passkey_id: string; passkey: string }>();
            allowCredentials = (results ?? []).map((row) => {
                const data = JSON.parse(row.passkey) as Passkey;
                return { type: "public-key", id: data.id || row.passkey_id, transports: data.transports };
            });
            if (!allowCredentials.length) return c.text(msgs.PasskeyNotFoundMsg, 404);
        }
        const options: PublicKeyCredentialRequestOptionsJSON = await generateAuthenticationOptions({
            rpID: rp.rpID,
            challenge: crypto.randomUUID(),
            allowCredentials,
            userVerification: 'required',
        });
        if (!(await storePasskeyChallenge(
            c.env,
            "authenticate",
            options.challenge,
            rp,
            challengeUserId,
        ))) {
            return c.text(msgs.OperationFailedMsg, 500);
        }
        return c.json(options);
    },
    authenticateResponse: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const body = await c.req.json<AuthenticateRequestBody>().catch((): AuthenticateRequestBody => ({}));
        const credential = body.credential;
        if (!isCredentialPayload(credential) || !isNonEmptyString(credential.id)) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        const rp = resolvePasskeyRpContext(
            c.req.raw.headers.get("Origin"),
            c.env.FRONTEND_URL,
        );
        if (!rp) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        const passkeyId = credential.id;
        const record = await c.env.DB.prepare(
            `SELECT user_id, counter, passkey FROM user_passkeys WHERE passkey_id = ?`
        ).bind(passkeyId).first<{
            counter: number | null; passkey: string; user_id: number;
        }>();
        if (!record?.passkey) {
            return c.text(msgs.PasskeyNotFoundMsg, 404);
        }
        if (!isAuthenticationCredential(credential)) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        let passkeyData: Passkey;
        try {
            passkeyData = JSON.parse(record.passkey) as Passkey;
            if (!isNonEmptyString(passkeyData.id) || !isNonEmptyString(passkeyData.publicKey)) {
                return c.text(msgs.AuthenticationFailedMsg, 400);
            }
        } catch {
            return c.text(msgs.AuthenticationFailedMsg, 400);
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: asAuthenticationResponse(credential),
                expectedChallenge: async (challenge: string) => {
                    const bound = await consumePasskeyChallenge(
                        c.env,
                        "authenticate",
                        challenge,
                        rp,
                        record.user_id,
                    );
                    if (bound) return true;
                    return consumePasskeyChallenge(
                        c.env,
                        "authenticate",
                        challenge,
                        rp,
                    );
                },
                expectedOrigin: rp.origin,
                expectedRPID: rp.rpID,
                requireUserVerification: true,
                credential: {
                    id: passkeyData.id,
                    publicKey: isoBase64URL.toBuffer(passkeyData.publicKey),
                    counter: record.counter ?? passkeyData.counter,
                    transports: passkeyData.transports,
                },
            });
        } catch {
            return c.text(msgs.AuthenticationFailedMsg, 400);
        }
        const { verified, authenticationInfo } = verification;
        if (!verified || !authenticationInfo || authenticationInfo.credentialID !== passkeyId) {
            return c.text(msgs.AuthenticationFailedMsg, 400);
        }

        const currentCounter = record.counter ?? passkeyData.counter ?? 0;
        const newCounter = authenticationInfo.newCounter;
        if (!Number.isSafeInteger(newCounter) || newCounter < 0) {
            return c.text(msgs.AuthenticationFailedMsg, 400);
        }
        const counterUpdate = await c.env.DB.prepare(
            `UPDATE user_passkeys
             SET counter = MAX(COALESCE(counter, 0), ?), updated_at = datetime('now')
             WHERE passkey_id = ? AND user_id = ? AND COALESCE(counter, 0) <= ?`
        ).bind(newCounter, passkeyId, record.user_id, newCounter).run();
        if (Number(counterUpdate.meta?.changes ?? 0) !== 1) {
            return c.text(msgs.AuthenticationFailedMsg, 409);
        }

        const { user_email } = await c.env.DB.prepare(
            `SELECT user_email FROM users WHERE id = ?`
        ).bind(record.user_id).first<{ user_email: string }>() || {};
        if (!user_email) {
            return c.text(msgs.UserNotFoundMsg, 404);
        }
        const issuedAt = Math.floor(Date.now() / 1000);
        const jwt = await Jwt.sign({
            user_email,
            user_id: record.user_id,
            exp: issuedAt + 30 * 24 * 60 * 60,
            iat: issuedAt,
        }, c.env.JWT_SECRET, "HS256");
        return c.json({ jwt });
    },
}
