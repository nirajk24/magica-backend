import { REASONING_TAIL_CHARS, type BlockProjection, type ContentBlock } from "@/contracts";

const MAX_PROJECTED_BLOCKS = 60;

type OpenReasoning = { text: string; startedAt: number };

export type TurnState = ReturnType<typeof createTurnState>;

/**
 * Accumulates one turn's content blocks and their realtime projection. Owns two rules: a closed
 * `text` block ends a step group, and only `text` blocks consume the agent-text stream.
 *
 * INVARIANT: prose goes in through `appendText` only. Reasoning leaves as `reasoningTail()` or a
 * closed `thinking` block, never onto the stream, or every later text block is offset.
 */
export function createTurnState() {
  const closed: ContentBlock[] = [];

  let segment = 0;
  let breakPending = false;
  let text = "";
  let reasoning: OpenReasoning | null = null;
  let streamChars = 0;

  const peekSegment = () => segment + (breakPending ? 1 : 0);

  const takeSegment = () => {
    if (breakPending) {
      segment++;
      breakPending = false;
    }
    return segment;
  };

  function closeText(): boolean {
    if (text === "") return false;

    closed.push({ segment: takeSegment(), type: "text", text });
    streamChars += text.length;
    text = "";
    breakPending = true;

    return true;
  }

  return {
    /** True when this delta opened a new text block, which nothing else in the projection signals. */
    appendText(delta: string): boolean {
      const opened = text === "";
      text += delta;

      return opened && text !== "";
    },

    closeText,

    appendReasoning(delta: string, now: number): void {
      reasoning ??= { text: "", startedAt: now };
      reasoning.text += delta;
    },

    /** The bounded window sent as `RunMetadata.reasoningText`; the block keeps the full text. */
    reasoningTail(): string | undefined {
      if (!reasoning) return undefined;
      return reasoning.text.slice(-REASONING_TAIL_CHARS);
    },

    /**
     * Trims the ends of the transcript, which text blocks must never do: `chars` has to equal the
     * characters actually appended to the stream, so trimming a text block would shift every offset
     * after it. Reasoning never touches the stream, so its whitespace is safe to drop.
     */
    closeReasoning(now: number): boolean {
      if (!reasoning) return false;

      closed.push({
        segment: takeSegment(),
        type: "thinking",
        thinking: reasoning.text.trim(),
        durationMs: Math.max(0, now - reasoning.startedAt),
      });
      reasoning = null;

      return true;
    },

    /** Closes any open text block first, which starts the new step group. */
    pushToolUse(a: { id: string; name: string; input: unknown }): void {
      closeText();
      closed.push({ segment: takeSegment(), type: "tool_use", ...a });
    },

    /** The assistant footer, not a step: it joins the current group and never takes the break. */
    pushUsage(a: { inputTokens: number; outputTokens: number }): void {
      closed.push({ segment, type: "usage", ...a });
    },

    /** Ends the current step group without emitting a block, for a resolved waitpoint. */
    breakSegment(): void {
      breakPending = true;
    },

    blocks(): ContentBlock[] {
      return [...closed];
    },

    /** Structure only, bounded because a snapshot over `RunMetadata.blocks`' cap kills the turn. */
    projection(): BlockProjection[] {
      const projected: BlockProjection[] = closed.map((block) => ({
        segment: block.segment,
        type: block.type,
        ...(block.type === "tool_use" ? { toolUseId: block.id, name: block.name } : {}),
        ...(block.type === "text" ? { chars: block.text.length } : {}),
      }));

      // An open block is projected as structure with no content, the same as a closed one — the
      // client renders the row and fills it from `reasoningText` or the text stream. Without this
      // a turn that is reasoning has an empty `blocks`, so the client has a live run with nothing
      // to draw and shows a blank where the reasoning is already arriving. Reasoning precedes text
      // within a turn, so it is pushed first.
      if (reasoning) {
        projected.push({ segment: peekSegment(), type: "thinking", streaming: true });
      }

      if (text !== "") {
        projected.push({ segment: peekSegment(), type: "text", streaming: true });
      }

      return projected.slice(-MAX_PROJECTED_BLOCKS);
    },

    /** Where the live block starts: characters already claimed by closed text blocks. */
    streamOffset(): number {
      return streamChars;
    },

    /** Step groups the emitted blocks occupy, derived from the blocks and never the pending break. */
    segments(): number {
      const highest = closed.reduce((max, block) => Math.max(max, block.segment), -1);
      const open = text === "" ? -1 : peekSegment();

      return Math.max(highest, open) + 1;
    },

    hasContent(): boolean {
      return closed.length > 0 || text !== "" || reasoning !== null;
    },
  };
}
