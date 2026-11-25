import { assertEnvFileNotSymlink, parseServerEnv, type ServerEnv } from "./env-schema";
import { registerSecret } from "./redact";

export { PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT, normalizeWebAddress } from "./env-schema";

assertEnvFileNotSymlink();
export const env: ServerEnv = parseServerEnv(process.env);
for (const name of ["MONDAY_API_TOKEN", "PLAKY_API_KEY"]) registerSecret(process.env[name]);
