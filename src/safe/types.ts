import type z from "zod";
import type { multisigTransactionSchema, safeTransactionWithDomain } from "./schemas.js";

export type SafeTransactionWithDomain = z.infer<typeof safeTransactionWithDomain>;
export type MultisigTransaction = z.infer<typeof multisigTransactionSchema>;
