import { createContext } from "@/server/trpc/context";
import { handleTrpc } from "@/server/trpc/handler";

const handler = (req: Request) => handleTrpc(req, createContext);

export { handler as GET, handler as POST };
