// Regenerates promo-examples.ts from promo-examples.md. Edge functions can't
// read a bundled .md at runtime, so the bot imports the text from a .ts file.
// Run after editing the .md: node supabase/functions/_shared/ev/gen-examples.mjs
import { readFileSync, writeFileSync } from "node:fs";
const md = readFileSync(new URL("./promo-examples.md", import.meta.url), "utf8");
writeFileSync(
  new URL("./promo-examples.ts", import.meta.url),
  `// Generated from promo-examples.md by gen-examples.mjs. Edit the .md, then rerun it.\nexport const PROMO_EXAMPLES_MD = ${JSON.stringify(md)};\n`,
);
