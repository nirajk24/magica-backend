/**
 * Collects http urls from anywhere in a node's output.
 *
 * The catalog documents `output` as an arbitrary per-node shape, so it is searched rather than
 * destructured — a node that nests its result one level deeper than expected still yields its file
 * instead of silently returning nothing.
 */
export function extractUrls(output: unknown): string[] {
  const urls: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string" && /^https?:\/\//.test(value)) urls.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };

  visit(output);
  return urls;
}
