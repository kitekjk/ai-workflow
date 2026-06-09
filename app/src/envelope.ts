import Ajv, { type AnySchema } from "ajv";
import type { Envelope } from "./domain";

const ajv = new Ajv({ allErrors: true });

const REFS_SCHEMA: AnySchema = {
  type: "array",
  items: {
    type: "object",
    required: ["system", "key"],
    properties: {
      system: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      label: { type: "string" },
    },
  },
};
const validateRefs = ajv.compile(REFS_SCHEMA);

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string };

/**
 * Validates the *shape* of an envelope: domainOutput against the job's output_schema
 * and refs against the fixed ref shape. Does NOT verify ref reachability (D4 bare claim).
 */
export function validateEnvelope(
  envelope: Envelope,
  outputSchema: Record<string, unknown>,
): ValidationResult {
  const validateDomain = ajv.compile(outputSchema as AnySchema);
  if (!validateDomain(envelope.domainOutput)) {
    return { ok: false, errors: ajv.errorsText(validateDomain.errors) };
  }
  if (!validateRefs(envelope.refs)) {
    return { ok: false, errors: ajv.errorsText(validateRefs.errors) };
  }
  return { ok: true };
}
