import z from "zod";
import { bigintStringSchema, checkedAddressSchema, hexDataSchema } from "../utils/schemas.js";

const bytes32Schema = hexDataSchema.refine((val) => val.length === 66, "Value is not 32 bytes");

export const authorizationSchema = z.object({
	from: checkedAddressSchema,
	to: checkedAddressSchema,
	value: bigintStringSchema,
	validAfter: bigintStringSchema,
	validBefore: bigintStringSchema,
	nonce: bytes32Schema,
});

export const eip3009PaymentSchema = z.object({
	type: z.literal("eip3009"),
	authorization: authorizationSchema,
	signature: hexDataSchema,
});

export const safeTxPaymentSchema = z.object({
	type: z.literal("safeTx"),
	paymentSafeTxHash: bytes32Schema,
});

export const checkRequestSchema = z.object({
	chainId: z.coerce.number().int(),
	safe: checkedAddressSchema,
	safeTxHash: bytes32Schema,
	payment: z.discriminatedUnion("type", [eip3009PaymentSchema, safeTxPaymentSchema]),
});

export const checkParamsSchema = z.object({
	chainId: z.coerce.number().int(),
	safeTxHash: bytes32Schema,
});
