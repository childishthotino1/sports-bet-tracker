// Loads promo-examples.md for the tests. Not a test file itself.
import { readFileSync } from "node:fs";
import { parseExamples } from "./promo.ts";

export const EXAMPLES = parseExamples(readFileSync(new URL("./promo-examples.md", import.meta.url), "utf8"));

export function example(title: string): Record<string, unknown> {
  const found = EXAMPLES.find((e) => e.title === title);
  if (!found) throw new Error(`No example titled "${title}" in promo-examples.md`);
  return found.json as Record<string, unknown>;
}
