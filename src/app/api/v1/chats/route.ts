import { ChatsQuery } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { listChats } from "@/services/chat.service";

export const GET = defineRoute({
  query: ChatsQuery,
  handler: ({ userId, query }) => listChats({ userId, ...query }),
});

export const OPTIONS = preflight;
