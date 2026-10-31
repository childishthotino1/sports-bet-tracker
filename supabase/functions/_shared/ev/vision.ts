// Reads a screenshot with Claude vision: a promo (its rules), a bet slip (its
// legs and price), or neither. Deno-only (npm: import), so it's kept out of
// mod.ts and the Node-run tests. The caller passes promo-examples.md's text.

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { imagePrompt, IMAGE_JSON_SCHEMA, readImageJson, type ImageRead } from "./image.ts";

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export async function readImage(
  client: Anthropic,
  base64: string,
  examplesMd: string,
  mediaType: ImageType = "image/jpeg",
): Promise<ImageRead> {
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: IMAGE_JSON_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: imagePrompt(examplesMd) },
      ],
    }],
  });

  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this image");
  if (res.stop_reason === "max_tokens") throw new Error("The read was cut off");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return readImageJson(JSON.parse(text));
}
