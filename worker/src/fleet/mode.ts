import { FleetError } from "./contracts.ts";

export type DeployedFleetMode = "legacy-static" | "observe";

/** Data-plane activation requires the complete D2/D3 provisioning and gate protocol. */
export function deployedFleetMode(env: { readonly FLEET_MODE?: string }): DeployedFleetMode {
    const mode = env.FLEET_MODE || "legacy-static";
    if (mode === "legacy-static" || mode === "observe") return mode;
    throw new FleetError("MODE_DISABLED", 503);
}
