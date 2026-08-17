import Schema from "typebox/schema";
export class ContractValidationError extends Error {
    reason;
    fieldPath;
    recovery;
    constructor(details, message) {
        super(message ?? details.reason);
        this.name = "ContractValidationError";
        this.reason = details.reason;
        this.fieldPath = details.fieldPath;
        this.recovery = details.recovery;
    }
}
export function compileContractParser(schema, defaults) {
    const validator = Schema.Compile(schema);
    return (value) => {
        if (validator.Check(value))
            return value;
        const [, errors] = validator.Errors(value);
        const first = errors[0];
        const fieldPath = first?.instancePath || "$";
        const message = first?.message ? `${defaults.reason}:${fieldPath}:${first.message}` : defaults.reason;
        throw new ContractValidationError({ ...defaults, fieldPath }, message);
    };
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
//# sourceMappingURL=contract-validation.js.map