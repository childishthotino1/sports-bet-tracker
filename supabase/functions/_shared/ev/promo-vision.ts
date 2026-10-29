// Reads a promo screenshot into a Promo with Claude vision (null when the
// image isn't a promo). Deno-only (npm:
// import), so it's kept out of mod.ts and the Node-run tests. The caller
// passes promo-examples.md's text (the bot reads it at startup).

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { normalizePromo, PROMO_JSON_SCHEMA, promoPrompt, type Promo } from "./promo.ts";

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export async function parsePromoImage(
  client: Anthropic,
  base64: string,
  examplesMd: string,
  mediaType: ImageType = "image/jpeg",
): Promise<Promo | null> {
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: PROMO_JSON_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: promoPrompt(examplesMd) },
      ],
    }],
  });

  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this image");
  if (res.stop_reason === "max_tokens") throw new Error("Promo read was cut off");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const raw = JSON.parse(text);
  return raw.is_promo === false ? null : normalizePromo(raw);
}
