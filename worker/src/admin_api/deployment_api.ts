import type { Context } from "hono";

import { collectDeploymentChecks } from "../core/deployment_check.ts";

/**
 * Diagnostic endpoint, not a health gate: it always answers 200 with a report
 * so an operator can read the failure instead of a bare 500. The admin auth
 * middleware on /admin/* is the only access control, and no check returns a
 * secret or a mail body.
 */
export default {
    check: async (c: Context<HonoCustomType>) => {
        const env = c.env as Bindings;
        try {
            return c.json(await collectDeploymentChecks(env));
        } catch (error) {
            console.error("deployment self-check failed", error);
            return c.json({
                status: "warning",
                checks: [{ name: "self_check", state: "warning", detail: "check failed; see Worker logs" }],
            });
        }
    },
};