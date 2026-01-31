/**
 * Aave lending CRE workflow (TypeScript).
 * Config shape aligned with agentic LendingNodeConfig / LendingInputConfig for future invocation from the app.
 * Trigger: cron (scheduled) or HTTP (one-off from app). Executes Aave operation via CRE report + AaveReceiver contract.
 */

import {
  bytesToHex,
  cre,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  type Runtime,
  type CronPayload,
  type HTTPPayload,
  TxStatus, sendErrorResponse,
} from '@chainlink/cre-sdk';
import { type Address, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbiParameters, zeroAddress } from 'viem';
import { z } from 'zod';
import { IPool } from '../contracts/abi';

// ---------- Config schema (aligned with agentic LendingNodeConfig / LendingInputConfig) ----------

const tokenInfoSchema = z.object({
  address: z.string(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
  aTokenAddress: z.string().optional(),
});

const inputConfigSchema = z.object({
  operation: z.enum(['SUPPLY', 'WITHDRAW', 'BORROW', 'REPAY', 'ENABLE_COLLATERAL', 'DISABLE_COLLATERAL']),
  asset: tokenInfoSchema,
  amount: z.string(),
  walletAddress: z.string(),
  interestRateMode: z.enum(['STABLE', 'VARIABLE']).optional(),
  onBehalfOf: z.string().optional(),
  referralCode: z.number().optional(),
});

const configSchema = z.object({
  schedule: z.string(),
  chain: z.string(),
  chainSelectorName: z.string(),
  provider: z.literal('AAVE'),
  aaveReceiverAddress: z.string(),
  poolAddress: z.string(),
  gasLimit: z.string(),
  inputConfig: inputConfigSchema,
  simulateFirst: z.boolean().optional(),
});

type Config = z.infer<typeof configSchema>;

// Operation enum for report encoding (matches AaveReceiver.sol)
const OP_SUPPLY = 0;
const OP_WITHDRAW = 1;
const OP_BORROW = 2;
const OP_REPAY = 3;

// interestRateMode: 1 = Stable, 2 = Variable
const INTEREST_RATE_STABLE = 1;
const INTEREST_RATE_VARIABLE = 2;

const POOL_ADDRESSES: Record<string, string> = {
  ARBITRUM: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  ARBITRUM_SEPOLIA: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
};

export type LendingResult = {
  success: boolean;
  txHash?: string;
  operation: string;
  amount: string;
  error?: string;
};

function getEvmClient(chainSelectorName: string, isTestnet: boolean) {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName,
    isTestnet,
  });
  if (!network) {
    throw new Error(`Network not found for chain selector: ${chainSelectorName}`);
  }
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function isTestnet(chain: string): boolean {
  return chain === 'ARBITRUM_SEPOLIA' || chain.toLowerCase().includes('sepolia');
}

function getInterestRateMode(mode?: string): number {
  if (mode === 'STABLE') return INTEREST_RATE_STABLE;
  return INTEREST_RATE_VARIABLE;
}

/**
 * Fetch aToken address from Aave Pool for a given asset (required for WITHDRAW).
 */
function getATokenAddress(
  runtime: Runtime<Config>,
  poolAddress: string,
  assetAddress: string,
  chainSelectorName: string,
  isTestnetChain: boolean
): string {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName,
    isTestnet: isTestnetChain,
  });
  if (!network) {
    throw new Error(`Network not found for chain selector: ${chainSelectorName}`);
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const callData = encodeFunctionData({
    abi: IPool,
    functionName: 'getReserveData',
    args: [assetAddress as Address],
  });

  const contractCall = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: poolAddress as Address,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();

  const reserveData = decodeFunctionResult({
    abi: IPool,
    functionName: 'getReserveData',
    data: bytesToHex(contractCall.data),
  });

  const aTokenAddr = Array.isArray(reserveData)
    ? (reserveData[8] as Address)
    : (reserveData as { aTokenAddress: Address }).aTokenAddress;
  return aTokenAddr;
}

/**
 * Encode Aave report payload for AaveReceiver contract.
 * Report format: (operation, poolAddress, asset, amount, walletAddress, onBehalfOf, interestRateMode, referralCode, aTokenAddress)
 */
function encodeLendingReport(params: {
  operation: number;
  poolAddress: string;
  asset: string;
  amount: string;
  walletAddress: string;
  onBehalfOf: string;
  interestRateMode: number;
  referralCode: number;
  aTokenAddress: string;
}): string {
  return encodeAbiParameters(
    parseAbiParameters(
      'uint8 operation, address poolAddress, address asset, uint256 amount, address walletAddress, address onBehalfOf, uint256 interestRateMode, uint16 referralCode, address aTokenAddress',
    ),
    [
      params.operation,
      params.poolAddress as Address,
      params.asset as Address,
      BigInt(params.amount),
      params.walletAddress as Address,
      params.onBehalfOf as Address,
      BigInt(params.interestRateMode),
      params.referralCode,
      params.aTokenAddress as Address,
    ],
  );
}

function doLending(runtime: Runtime<Config>): string {
  const config = runtime.config;
  const { operation, asset, amount, walletAddress } = config.inputConfig;

  if (!config.aaveReceiverAddress || config.aaveReceiverAddress === '') {
    const result: LendingResult = {
      success: false,
      operation,
      amount,
      error: 'aaveReceiverAddress is required; deploy AaveReceiver and set in config',
    };
    return JSON.stringify(result);
  }

  // ENABLE_COLLATERAL and DISABLE_COLLATERAL require the user to call the Pool directly
  // (Aave's setUserUseReserveAsCollateral uses msg.sender as the user).
  if (operation === 'ENABLE_COLLATERAL' || operation === 'DISABLE_COLLATERAL') {
    const result: LendingResult = {
      success: false,
      operation,
      amount,
      error: 'ENABLE_COLLATERAL and DISABLE_COLLATERAL must be called directly by the user; use Pool.setUserUseReserveAsCollateral(asset, useAsCollateral)',
    };
    return JSON.stringify(result);
  }

  const opCode =
    operation === 'SUPPLY'
      ? OP_SUPPLY
      : operation === 'WITHDRAW'
        ? OP_WITHDRAW
        : operation === 'BORROW'
          ? OP_BORROW
          : OP_REPAY;

  const poolAddress = config.poolAddress || POOL_ADDRESSES[config.chain];
  if (!poolAddress) {
    const result: LendingResult = {
      success: false,
      operation,
      amount,
      error: `poolAddress not configured for chain: ${config.chain}`,
    };
    return JSON.stringify(result);
  }

  const chainSelectorName = config.chainSelectorName;
  const isTestnetChain = isTestnet(config.chain);
  const evmClient = getEvmClient(chainSelectorName, isTestnetChain);

  const assetAddress = asset.address;
  const onBehalfOf = config.inputConfig.onBehalfOf || walletAddress;
  const interestRateMode = getInterestRateMode(config.inputConfig.interestRateMode);
  const referralCode = config.inputConfig.referralCode ?? 0;

  let aTokenAddress = asset.aTokenAddress ?? '0x0000000000000000000000000000000000000000';
  if (operation === 'WITHDRAW') {
    if (!aTokenAddress || aTokenAddress === '0x0000000000000000000000000000000000000000') {
      aTokenAddress = getATokenAddress(runtime, poolAddress, assetAddress, chainSelectorName, isTestnetChain);
    }
  }

  const reportPayloadHex = encodeLendingReport({
    operation: opCode,
    poolAddress,
    asset: assetAddress,
    amount,
    walletAddress,
    onBehalfOf,
    interestRateMode,
    referralCode,
    aTokenAddress,
  });

  runtime.log(
    `Aave ${operation}: asset=${assetAddress} amount=${amount} wallet=${walletAddress} onBehalfOf=${onBehalfOf}`,
  );

  const reportPayloadBytes =
    reportPayloadHex.startsWith('0x') ? reportPayloadHex : (`0x${reportPayloadHex}` as `0x${string}`);
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportPayloadBytes),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
    .result();

  const resp = evmClient
    .writeReport(runtime, {
      receiver: config.aaveReceiverAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: config.gasLimit,
      },
    })
    .result();

  const txStatus = resp.txStatus;
  const txHash = resp.txHash ? bytesToHex(resp.txHash) : undefined;

  if (txStatus !== TxStatus.SUCCESS) {
    const result: LendingResult = {
      success: false,
      operation,
      amount,
      error: resp.errorMessage ?? `tx status: ${txStatus}`,
    };
    return JSON.stringify(result);
  }

  runtime.log(`Aave ${operation} tx succeeded: ${txHash}`);

  const result: LendingResult = {
    success: true,
    txHash,
    operation,
    amount,
  };
  return JSON.stringify(result);
}

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Running Aave lending (cron trigger)');
  return doLending(runtime);
};

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log('Running Aave lending (HTTP trigger)');
  if (payload.input && payload.input.length > 0) {
    try {
      const body = decodeJson(payload.input);
      runtime.log(`HTTP body: ${JSON.stringify(body)}`);
    } catch {
      // ignore parse errors; use runtime.config
    }
  }
  return doLending(runtime);
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  const httpTrigger = new cre.capabilities.HTTPCapability();

  return [
    cre.handler(
      cron.trigger({
        schedule: config.schedule,
      }),
      onCronTrigger,
    ),
    cre.handler(httpTrigger.trigger({}), onHttpTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main().catch(sendErrorResponse)
