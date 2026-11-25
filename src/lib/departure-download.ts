import { z } from "zod";

export const departureDownload = z.object({
  url: z.string().regex(/^\/api\/departure\/download\/[a-f0-9-]{36}$/), expiresAt: z.number(),
  status: z.enum(["review_required", "incomplete"]), boards: z.number(), attachments: z.number(), failures: z.number(),
});
