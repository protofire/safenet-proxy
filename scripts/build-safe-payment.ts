// Prints the Safe transaction fields for the fee payment USDC.transfer(FEE_COLLECTOR, fee),
// to create it by hand in the Safe app's Transaction Builder.
//
// Usage: npm run build-safe-payment            (reads FEE_COLLECTOR from .env)
//        npm run build-safe-payment -- <feeCollector>
import { encodeFunctionData, getAddress } from "viem";
import { CHECK_FEE, CHECKS_CHAIN_ID, USDC_ADDRESS } from "../src/checks/config.js";
import { USDC_FUNCTIONS } from "../src/utils/abis.js";

const feeCollectorArg = process.argv[2] ?? process.env.FEE_COLLECTOR;
if (feeCollectorArg === undefined || feeCollectorArg === "") {
	console.error("Usage: npm run build-safe-payment -- <feeCollector>  (or set FEE_COLLECTOR)");
	process.exit(1);
}
const feeCollector = getAddress(feeCollectorArg);

console.log(
	JSON.stringify(
		{
			chainId: CHECKS_CHAIN_ID,
			to: USDC_ADDRESS,
			value: "0",
			data: encodeFunctionData({ abi: USDC_FUNCTIONS, functionName: "transfer", args: [feeCollector, CHECK_FEE] }),
			operation: 0,
		},
		null,
		2,
	),
);
console.log(`\nTransaction Builder: contract ${USDC_ADDRESS}, method transfer(to=${feeCollector}, value=${CHECK_FEE})`);
