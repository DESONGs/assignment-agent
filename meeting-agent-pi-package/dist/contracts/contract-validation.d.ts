import type { Static, TSchema } from "typebox";
export type ContractFailureDetails = {
    reason: string;
    fieldPath: string;
    recovery: string;
};
export declare class ContractValidationError extends Error {
    readonly reason: string;
    readonly fieldPath: string;
    readonly recovery: string;
    constructor(details: ContractFailureDetails, message?: string);
}
export declare function compileContractParser<const Contract extends TSchema>(schema: Contract, defaults: Pick<ContractFailureDetails, "reason" | "recovery">): (value: unknown) => Static<Contract>;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function stableStringify(value: unknown): string;
//# sourceMappingURL=contract-validation.d.ts.map