import crypto from "node:crypto";

const SALT = "omniroute-cli-auth-v1";
export const CLI_TOKEN_HEADER = "x-omniroute-cli-token";

let _cached = null;

export async function getCliToken() {
  if (_cached !== null) return _cached;
  try {
    const module = await import("node-machine-id");
    const machineIdSync = module.machineIdSync ?? module.default?.machineIdSync;
    if (typeof machineIdSync !== "function") throw new Error("machine-id API unavailable");
    const mid = machineIdSync(true);
    _cached = crypto.createHmac("sha256", mid).update(SALT).digest("hex");
  } catch {
    _cached = "";
  }
  return _cached;
}
