import Schema from "typebox/schema";
import type { Static, TSchema } from "typebox";

export type ContractFailureDetails = {
  reason: string;
  fieldPath: string;
  recovery: string;
};

export class ContractValidationError extends Error {
  readonly reason: string;
  readonly fieldPath: string;
  readonly recovery: string;

  constructor(details: ContractFailureDetails, message?: string) {
    super(message ?? details.reason);
    this.name = "ContractValidationError";
    this.reason = details.reason;
    this.fieldPath = details.fieldPath;
    this.recovery = details.recovery;
  }
}

export function compileContractParser<const Contract extends TSchema>(
  schema: Contract,
  defaults: Pick<ContractFailureDetails, "reason" | "recovery">,
) {
  const validator = Schema.Compile(schema);
  return (value: unknown): Static<Contract> => {
    if (validator.Check(value)) return value;
    const [, errors] = validator.Errors(value);
    const first = errors[0];
    const fieldPath = first?.instancePath || "$";
    const message = first?.message ? `${defaults.reason}:${fieldPath}:${first.message}` : defaults.reason;
    throw new ContractValidationError({ ...defaults, fieldPath }, message);
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
