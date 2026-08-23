/**
 * Opaque keyset cursor over a `(timestamp DESC, id DESC)` composite index. The client never sees
 * the parts; a page after the cursor filters on `at < ? OR (at = ? AND id < ?)`.
 */
export function encodeCursor(row: { at: Date; id: string }): string {
  return Buffer.from(`${row.at.toISOString()}|${row.id}`).toString("base64url");
}

/** Null on anything malformed, so a tampered cursor reads as "first page" rather than a 500. */
export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id) return null;

  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}
