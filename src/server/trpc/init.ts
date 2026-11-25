import { TRPCError, initTRPC, type TRPCDefaultErrorShape as DefaultErrorShape } from "@trpc/server";
import { Explanation, explainError } from "../explain-error";
import { redactString } from "../redact";
import type { Context } from "./context";

export function formatError({ shape, error }: { shape: DefaultErrorShape; error: unknown }): DefaultErrorShape & { data: { technical: string | null } } {
  const { code, httpStatus, path } = shape.data;
  const explained = (error as { cause?: unknown })?.cause instanceof Explanation ? { text: shape.message, technical: ((error as { cause: Explanation }).cause).technical } : explainError(error);
  return {
    ...shape,
    message: redactString(explained.text),
    data: { code, httpStatus, ...(path === undefined ? {} : { path }), technical: explained.technical === null ? null : redactString(explained.technical) },
  };
}

const t = initTRPC.context<Context>().create({ errorFormatter: formatError });

const explained = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && !(result.error.cause instanceof Explanation)) {
    const out = explainError(result.error);
    throw new TRPCError({ code: out.code, message: out.text, cause: new Explanation(out.technical, result.error.cause ?? result.error) });
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(explained);
