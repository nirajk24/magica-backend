import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const TESTS = join(ROOT, "tests");

/**
 * Entry points: something outside this repo reaches these, so no local reference is expected.
 * Contracts are consumed by the frontend, `app/` by Next's router, `generated/` is codegen, and
 * anything assigned from `task(` is found by Trigger.dev's directory scan.
 */
const SKIP_DIRS = ["contracts", "app", "generated"];
const SKIP_FILES = ["proxy.ts"];

const EXPORT = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
const TASK = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:task|schedules\.task)\(/g;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const read = (paths: string[]) => paths.map((path) => ({ path, body: readFileSync(path, "utf8") }));

const src = read(sourceFiles(SRC));
const tests = read(sourceFiles(TESTS));

const skip = (rel: string) =>
  SKIP_DIRS.some((dir) => rel.startsWith(`${dir}/`)) || SKIP_FILES.includes(rel);

const dead: string[] = [];
const testsOnly: string[] = [];

for (const file of src) {
  const rel = relative(SRC, file.path);
  if (skip(rel)) continue;

  const tasks = new Set([...file.body.matchAll(TASK)].map((m) => m[1]));

  for (const match of file.body.matchAll(EXPORT)) {
    const name = match[1]!;
    if (tasks.has(name)) continue;

    const used = (files: { path: string; body: string }[]) =>
      files.some(
        (other) => other.path !== file.path && new RegExp(`\\b${name}\\b`).test(other.body),
      );

    if (used(src)) continue;
    (used(tests) ? testsOnly : dead).push(`${rel}  →  ${name}`);
  }
}

if (testsOnly.length > 0) {
  console.log(
    `check-wiring: ${testsOnly.length} export(s) reached ONLY from tests.\n` +
      "A module with passing tests and no production caller is not finished. Each of these is\n" +
      "either a deliberate test helper or the next step's work — decide which, do not skip.\n",
  );
  for (const line of testsOnly) console.log(`  ${line}`);
  console.log("");
}

if (dead.length > 0) {
  console.error(`check-wiring: ${dead.length} export(s) referenced from NOWHERE.\n`);
  for (const line of dead) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`check-wiring: no dead exports (${src.length} files scanned).`);
