import { buildDeparture } from "@/server/departure/handler";
import { createContext } from "@/server/trpc/context";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return buildDeparture(req, (await context.params).id, createContext);
}
