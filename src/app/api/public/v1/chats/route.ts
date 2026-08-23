import { ChatsQuery, type ChatsPage } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { listChats } from "@/services/chat.service";

/** Conversation list, cursor-paginated. Same service the app's own sidebar reads. */
export const GET = definePublicApiRoute({
  query: ChatsQuery,
  handler: ({ userId, query }): Promise<ChatsPage> => listChats({ userId, ...query }),
});

export const OPTIONS = preflight;
