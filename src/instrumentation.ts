export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PHASE_PRODUCTION_BUILD } = await import("next/constants");
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const { startupRefusal } = await import("@/server/env-schema");
  const refusal = startupRefusal(process.env);
  if (refusal) {
    console.error(refusal);
    globalThis.process.exit(1);
  }
  try {
    const { getDb } = await import("@/db/client");
    const { rearmResumes, rearmSchedules } = await import("@/server/jobs/runner");
    const armed = await rearmResumes(await getDb());
    if (armed) console.info(`re-armed ${armed} automatic resume(s) waiting for monday's daily limit`);
    const scheduled = await rearmSchedules(await getDb());
    if (scheduled) console.info(`re-armed ${scheduled} scheduled "Bring over changes"`);
  } catch (error) {
    const { logger } = await import("@/server/redact");
    logger.error(`could not re-arm the automatic resumes (${error instanceof Error ? error.message : String(error)})`);
  }
}
