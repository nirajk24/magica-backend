import { describe, expect, it } from "vitest";
import { assertTransition } from "@/services/run.service";

const ALL = ["queued", "running", "waiting", "completed", "failed", "cancelled"] as const;

describe("assertTransition", () => {
  it("walks the happy path", () => {
    expect(() => assertTransition("queued", "running")).not.toThrow();
    expect(() => assertTransition("running", "completed")).not.toThrow();
  });

  it("allows a waitpoint round trip", () => {
    expect(() => assertTransition("running", "waiting")).not.toThrow();
    expect(() => assertTransition("waiting", "running")).not.toThrow();
    expect(() => assertTransition("waiting", "completed")).not.toThrow();
  });

  it("allows every non-terminal status to be cancelled or failed", () => {
    for (const from of ["queued", "running", "waiting"] as const) {
      expect(() => assertTransition(from, "cancelled")).not.toThrow();
      expect(() => assertTransition(from, "failed")).not.toThrow();
    }
  });

  it("re-marks a non-terminal status without complaining, which a resumed attempt does", () => {
    for (const from of ["queued", "running", "waiting"] as const) {
      expect(() => assertTransition(from, from)).not.toThrow();
    }
  });

  it("never lets a completed run move anywhere", () => {
    for (const to of ALL) {
      expect(() => assertTransition("completed", to)).toThrow(/illegal run transition/);
    }
  });

  it("lets a failed or cancelled run be retried, and nothing else", () => {
    for (const from of ["failed", "cancelled"] as const) {
      expect(() => assertTransition(from, "queued")).not.toThrow();

      for (const to of ALL.filter((status) => status !== "queued")) {
        expect(() => assertTransition(from, to)).toThrow(/illegal run transition/);
      }
    }
  });

  it("refuses to jump a queued run straight to completed", () => {
    expect(() => assertTransition("queued", "completed")).toThrow(/illegal run transition/);
  });

  it("names both ends in the message, so a log line is enough to place the bug", () => {
    expect(() => assertTransition("completed", "running")).toThrow(
      "illegal run transition: completed -> running",
    );
  });
});
