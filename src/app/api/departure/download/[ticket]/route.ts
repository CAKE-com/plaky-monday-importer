import { serveDeparture } from "@/server/departure/handler";

export async function GET(req: Request, context: { params: Promise<{ ticket: string }> }): Promise<Response> {
  return serveDeparture(req, (await context.params).ticket);
}
