import { streams } from "@trigger.dev/sdk";
import { STREAM_AGENT_TEXT } from "@/contracts";

/**
 * The turn's prose, append-only, declared once so writer and reader cannot disagree on the key.
 *
 * INVARIANT: text blocks only. `BlockProjection.chars` slices this stream, so anything else
 * written shifts every block after it.
 */
export const agentText = streams.define<string>({ id: STREAM_AGENT_TEXT });
