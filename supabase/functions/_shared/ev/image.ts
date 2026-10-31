// The vision call's schema, prompt, and parsing: one screenshot is a promo, a
// bet slip, or neither. Pure, so it's tested under Node.

import { normalizePromo, PROMO_JSON_SCHEMA, promoPrompt, type Promo } from "./promo.ts";
import { normalizeSlip, SLIP_JSON_SCHEMA, SLIP_PROMPT, type Slip } from "./slip.ts";

export const IMAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "promo", "slip"],
  properties: {
    kind: { type: "string", enum: ["promo", "slip", "other"] },
    promo: { anyOf: [PROMO_JSON_SCHEMA, { type: "null" }] },
    slip: { anyOf: [SLIP_JSON_SCHEMA, { type: "null" }] },
  },
} as const;

export function imagePrompt(examplesMd: string): string {
  return `Is this screenshot a sportsbook promotion, a bet slip, or neither? Set "kind" to "promo", "slip" or "other", fill the matching object, and set the other one to null.

${promoPrompt(examplesMd)}

${SLIP_PROMPT}`;
}

export type ImageRead = { kind: "promo"; promo: Promo } | { kind: "slip"; slip: Slip } | { kind: "other" };

export function readImageJson(raw: unknown): ImageRead {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === "promo" && r.promo) return { kind: "promo", promo: normalizePromo(r.promo) };
  if (r.kind === "slip") {
    const slip = normalizeSlip(r.slip);
    if (slip) return { kind: "slip", slip };
  }
  return { kind: "other" };
}
