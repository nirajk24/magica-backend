import { randomBytes } from "node:crypto";

/**
 * UUIDv7 — a 48-bit big-endian millisecond timestamp followed by random bits, so ids sort by
 * creation time. The schema declares `@default(uuid(7))`, but Prisma generates that client-side
 * and `lib/credits` inserts through raw SQL, which bypasses it. Using v4 there instead would
 * silently give the ledger's primary key random ordering and lose index locality on the one
 * table that only ever grows.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();

  bytes.writeUIntBE(Math.floor(ms / 0x10000), 0, 4);
  bytes.writeUInt16BE(ms & 0xffff, 4);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
