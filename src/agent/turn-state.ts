import { REASONING_TAIL_CHARS, type BlockProjection, type ContentBlock } from "@/contracts";

const MAX_PROJECTED_BLOCKS = 60;

type OpenReasoning = { text: string; startedAt: number };

export type TurnState = ReturnType<typeof createTurnState>;

/**
 * Accumulates one assistant turn's content blocks and their realtime projection.
 *
 * Two rules live here and nowhere else. **Segments**: a closed `text` block ends a step group, so
 * whatever comes next starts a new one — reasoning and tool rows are counted inside a group, not as
 * breaks. **Stream offsets**: only `text` blocks consume the agent-text stream, so only they carry
 * `chars`, and the count is written when the block closes so a closed block's slice never moves.
 *
 * INVARIANT: prose is added through `appendText` only. Reasoning is held separately and leaves as
 * `reasoningTail()` while live and a `thinking` block once closed — appending it to the text stream
 * would offset every following text block by the length of the transcript.
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
    appendText(delta: string): void {
      text += delta;
    },

    closeText,

    appendReasoning(delta: string, now: number): void {
      reasoning ??= { text: "", startedAt: now };
      reasoning.text += delta;
    },

    /** The bounded window sent as `RunMetadata.reasoningText`; the full text is kept for the block. */
    reasoningTail(): string | undefined {
      if (!reasoning) return undefined;
      return reasoning.text.slice(-REASONING_TAIL_CHARS);
    },

    closeReasoning(now: number): boolean {
      if (!reasoning) return false;

      closed.push({
        segment: takeSegment(),
        type: "thinking",
        thinking: reasoning.text,
        durationMs: Math.max(0, now - reasoning.startedAt),
      });
      reasoning = null;

      return true;
    },

    /** Closes any open text block first, which is what makes the tool call start a new step group. */
    pushToolUse(a: { id: string; name: string; input: unknown }): void {
      closeText();
      closed.push({ segment: takeSegment(), type: "tool_use", ...a });
    },

    /**
     * The assistant footer, not a step. It joins the current group rather than taking the queued
     * break — consuming one would render a step group whose only row is a token count.
     */
    pushUsage(a: { inputTokens: number; outputTokens: number }): void {
      closed.push({ segment, type: "usage", ...a });
    },

    /** Ends the current step group without emitting a block — used when a waitpoint resolves. */
    breakSegment(): void {
      breakPending = true;
    },

    blocks(): ContentBlock[] {
      return [...closed];
    },

    /**
     * Structure only, bounded to the newest `MAX_PROJECTED_BLOCKS` because `RunMetadata.blocks`
     * caps at 60 and a rejected snapshot would take the whole turn down. The complete timeline is
     * read back over REST, so the live view losing its oldest rows costs nothing.
     */
    projection(): BlockProjection[] {
      const projected: BlockProjection[] = closed.map((block) => ({
        segment: block.segment,
        type: block.type,
        ...(block.type === "tool_use" ? { toolUseId: block.id, name: block.name } : {}),
        ...(block.type === "text" ? { chars: block.text.length } : {}),
      }));

      if (text !== "") {
        projected.push({ segment: peekSegment(), type: "text", streaming: true });
      }

      return projected.slice(-MAX_PROJECTED_BLOCKS);
    },

    /** Characters already claimed by closed text blocks — the offset the live block starts at. */
    streamOffset(): number {
      return streamChars;
    },

    /**
     * How many step groups the emitted blocks occupy. Derived from the blocks, never from the
     * pending break — a turn that ends on text has a break queued that nothing will ever fill.
     */
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
