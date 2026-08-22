import { streams } from "@trigger.dev/sdk";
import { STREAM_AGENT_TEXT } from "@/contracts";

/**
 * The turn's prose, append-only. Declared once so the writer in the task and the reader in the
 * frontend cannot disagree about the key or the chunk type.
 *
 * INVARIANT: text blocks are the only thing appended here. `BlockProjection.chars` slices this
 * stream by block, so anything else written would shift every block after it.
 */
export const agentText = streams.define<string>({ id: STREAM_AGENT_TEXT });
