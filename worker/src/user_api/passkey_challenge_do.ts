const CHALLENGE_VALUE_KEY = "value";

/**
 * Authoritative single-use WebAuthn challenge store. A Durable Object is
 * selected by the complete challenge key, so each challenge is consumed under
 * one serialized object transaction even when requests arrive at different
 * Worker isolates.
 */
export class PasskeyChallengeDurableObject implements DurableObject {
    constructor(private readonly state: DurableObjectState) {}

    async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        const body = await request.json<{ action?: string; expiresAt?: number }>().catch(() => null);
        if (!body || (body.action !== "store" && body.action !== "consume")) {
            return Response.json({ ok: false, error: "invalid challenge request" }, { status: 400 });
        }

        const expiresAt = body.expiresAt;
        if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
            return Response.json({ ok: false, error: "invalid challenge request" }, { status: 400 });
        }
        const now = Date.now();
        return this.state.storage.transaction(async (txn) => {
            const current = await txn.get<number>(CHALLENGE_VALUE_KEY);
            if (current !== undefined && current <= now) {
                await txn.delete(CHALLENGE_VALUE_KEY);
            }
            if (body.action === "store") {
                if (expiresAt <= now) {
                    return Response.json({ ok: false, error: "challenge expired" }, { status: 400 });
                }
                await txn.put(CHALLENGE_VALUE_KEY, expiresAt);
                await txn.setAlarm(expiresAt);
                return Response.json({ ok: true });
            }
            const expiry = current;
            if (expiry === undefined || expiry <= now) {
                return Response.json({ ok: false, error: "challenge unavailable" }, { status: 404 });
            }
            await txn.delete(CHALLENGE_VALUE_KEY);
            return Response.json({ ok: true });
        });
    }

    async alarm(): Promise<void> {
        await this.state.storage.delete(CHALLENGE_VALUE_KEY);
    }
}
