import type { AssetDTO } from "@/contracts";
import { getTool } from "@/tools/registry";

/**
 * The media one completed invocation produced, priced and attributed.
 *
 * The tool's own `assets` declaration supplies url and type; cost and provenance are added here
 * because a tool has no business knowing what it was charged. A tool that declares nothing produces
 * nothing, which is how non-media tools stay silent.
 *
 * The invocation's whole cost is attached to each of its files; the authoritative total is the
 * message's `creditUsed`, not the sum of these.
 */
export function assetsFromInvocation(invocation: {
  toolName: string;
  output: unknown;
  creditUsed: bigint;
  toolUseId: string;
}): AssetDTO[] {
  const tool = getTool(invocation.toolName);
  if (!tool?.assets) return [];

  const parsed = tool.output.safeParse(invocation.output);
  if (!parsed.success) return [];

  return tool.assets(parsed.data).map((media) => ({
    url: media.url,
    type: media.type,
    model: invocation.toolName,
    creditUsed: invocation.creditUsed.toString(),
    toolCallId: invocation.toolUseId,
  }));
}
