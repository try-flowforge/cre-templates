/**
 * Uniswap V4 swap CRE workflow (TypeScript).
 * Config shape aligned with agentic SwapNodeConfig / SwapInputConfig for future invocation from the app.
 * Trigger: cron (scheduled) or HTTP (one-off from app). Executes swap via CRE report + SwapReceiver contract.
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
  TxStatus,
} from '@chainlink/cre-sdk';
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbiParameters,
  keccak256,
  zeroAddress,
} from 'viem';
import { z } from 'zod';

// ---------- Config schema (aligned with agentic SwapNodeConfig / SwapInputConfig) ----------

const tokenInfoSchema = z.object({
  address: z.string(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
});

const poolConfigSchema = z.object({
  fee: z.number(),
  tickSpacing: z.number(),
  hooks: z.string().optional(),
});

const inputConfigSchema = z.object({
  sourceToken: tokenInfoSchema,
  destinationToken: tokenInfoSchema,
  amount: z.string(),
  swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT']),
  walletAddress: z.string(),
  slippageTolerance: z.number().optional(),
  deadline: z.number().optional(),
  amountOutMinimum: z.string().optional(),
  amountInMaximum: z.string().optional(),
});

const configSchema = z.object({
  schedule: z.string(),
  chain: z.string(),
  chainSelectorName: z.string(),
  provider: z.literal('UNISWAP'),
  swapReceiverAddress: z.string(),
  poolSwapTestAddress: z.string(),
  poolManagerAddress: z.string(),
  stateViewAddress: z.string().optional(),
  gasLimit: z.string(),
  inputConfig: inputConfigSchema,
  poolConfig: poolConfigSchema.optional(),
  simulateFirst: z.boolean().optional(),
  feeTier: z.number().optional(), // deprecated, use poolConfig.fee
  routerAddress: z.string().optional(), // deprecated, use poolSwapTestAddress
});

type Config = z.infer<typeof configSchema>;

// Uniswap V4 default fee (0.3% = 3000 pips)
const DEFAULT_FEE = 3000;
// Default tick spacing for 0.3% fee tier
const DEFAULT_TICK_SPACING = 60;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Default deadline: 20 minutes from now (set at execution time)
const DEFAULT_DEADLINE_SECONDS = 20 * 60;

// Uniswap V4 sqrtPrice bounds for swap limits
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const MIN_SQRT_PRICE_PLUS_ONE = 4295128740n;
const MAX_SQRT_PRICE_MINUS_ONE = MAX_SQRT_PRICE - 1n;

const STATE_VIEW_ABI = [
  {
    name: 'getSlot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
] as const;

function getPoolId(currency0: string, currency1: string, fee: number, tickSpacing: number, hooks: string): `0x${string}` {
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, address, uint24, int24, address'),
    [currency0 as Address, currency1 as Address, fee, tickSpacing, hooks as Address],
  );
  return keccak256(encoded);
}

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

/**
 * Derive sorted currency0/currency1 and zeroForOne from source/destination tokens.
 * currency0 < currency1 (sorted by address).
 * zeroForOne: true = swap currency0 -> currency1, false = currency1 -> currency0.
 */
function derivePoolKeyParams(sourceToken: string, destToken: string) {
  const addr0 = sourceToken.toLowerCase() < destToken.toLowerCase() ? sourceToken : destToken;
  const addr1 = sourceToken.toLowerCase() < destToken.toLowerCase() ? destToken : sourceToken;
  const zeroForOne = sourceToken.toLowerCase() === addr0.toLowerCase();
  return { currency0: addr0, currency1: addr1, zeroForOne };
}

/**
 * Encode V4 swap report payload for SwapReceiver contract.
 * Report format: (currency0, currency1, fee, tickSpacing, hooks, zeroForOne, amountIn, amountOutMin, hookData, recipient, deadline, poolSwapTestAddress, poolManagerAddress, sqrtPriceLimitX96)
 */
function encodeSwapReport(params: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  zeroForOne: boolean;
  amountIn: string;
  amountOutMin: string;
  hookData: `0x${string}`;
  recipient: string;
  deadline: number;
  poolSwapTestAddress: string;
  poolManagerAddress: string;
  sqrtPriceLimitX96: bigint;
}): string {
  return encodeAbiParameters(
    parseAbiParameters(
      'address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, bool zeroForOne, uint256 amountIn, uint256 amountOutMin, bytes hookData, address recipient, uint256 deadline, address poolSwapTestAddress, address poolManagerAddress, uint160 sqrtPriceLimitX96',
    ),
    [
      params.currency0 as Address,
      params.currency1 as Address,
      params.fee,
      params.tickSpacing,
      params.hooks as Address,
      params.zeroForOne,
      BigInt(params.amountIn),
      BigInt(params.amountOutMin),
      params.hookData,
      params.recipient as Address,
      BigInt(params.deadline),
      params.poolSwapTestAddress as Address,
      params.poolManagerAddress as Address,
      params.sqrtPriceLimitX96,
    ],
  );
}

export type SwapResult = {
  success: boolean;
  txHash?: string;
  amountIn: string;
  amountOut?: string;
  error?: string;
};

function doSwap(runtime: Runtime<Config>): string {
  const config = runtime.config;

  if (!config.swapReceiverAddress || config.swapReceiverAddress === '') {
    const result: SwapResult = {
      success: false,
      amountIn: config.inputConfig.amount,
      error: 'swapReceiverAddress is required; deploy SwapReceiver and set in config',
    };
    return JSON.stringify(result);
  }
  if (!config.poolSwapTestAddress || config.poolSwapTestAddress === '') {
    const result: SwapResult = {
      success: false,
      amountIn: config.inputConfig.amount,
      error: 'poolSwapTestAddress is required (Uniswap V4 PoolSwapTest); set in config',
    };
    return JSON.stringify(result);
  }
  if (!config.poolManagerAddress || config.poolManagerAddress === '') {
    const result: SwapResult = {
      success: false,
      amountIn: config.inputConfig.amount,
      error: 'poolManagerAddress is required (Uniswap V4 PoolManager); set in config',
    };
    return JSON.stringify(result);
  }

  const chainSelectorName = config.chainSelectorName;
  const isTestnetChain = isTestnet(config.chain);
  const evmClient = getEvmClient(chainSelectorName, isTestnetChain);

  const sourceToken = config.inputConfig.sourceToken.address;
  const destToken = config.inputConfig.destinationToken.address;
  const amountIn = config.inputConfig.amount;
  const recipient = config.inputConfig.walletAddress;

  const poolConfig = config.poolConfig ?? { fee: undefined, tickSpacing: undefined, hooks: undefined };
  const fee = poolConfig?.fee ?? config.feeTier ?? DEFAULT_FEE;
  const tickSpacing = poolConfig?.tickSpacing ?? DEFAULT_TICK_SPACING;
  const hooks = poolConfig?.hooks ?? ZERO_ADDRESS;

  const { currency0, currency1, zeroForOne } = derivePoolKeyParams(sourceToken, destToken);

  let amountOutMin = '0';
  if (config.inputConfig.swapType === 'EXACT_INPUT') {
    amountOutMin = config.inputConfig.amountOutMinimum ?? '0';
    if (amountOutMin === '0') {
      runtime.log('amountOutMinimum not set; using 0 (no slippage protection). Set amountOutMinimum in config.');
    }
  }

  const deadline = config.inputConfig.deadline
    ? config.inputConfig.deadline
    : Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;

  const hookData = '0x' as `0x${string}`;

  // Fetch current pool price to compute sqrtPriceLimitX96 (avoids PriceLimitAlreadyExceeded when pool at extremes)
  const stateViewAddress =
    config.stateViewAddress ?? (isTestnetChain ? '0x9d467fa9062b6e9b1a46e26007ad82db116c67cb' : '');
  let sqrtPriceLimitX96: bigint;

  if (stateViewAddress) {
    const poolId = getPoolId(currency0, currency1, fee, tickSpacing, hooks);
    const callData = encodeFunctionData({
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    });
    const contractCall = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: stateViewAddress as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const [currentSqrtPriceX96] = decodeFunctionResult({
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      data: bytesToHex(contractCall.data),
    }) as [bigint, number, number, number];

    if (currentSqrtPriceX96 === 0n) {
      const result: SwapResult = {
        success: false,
        amountIn,
        error: 'Pool not initialized; create the pool first',
      };
      return JSON.stringify(result);
    }

    if (zeroForOne) {
      sqrtPriceLimitX96 = currentSqrtPriceX96 - 1n;
      if (sqrtPriceLimitX96 <= MIN_SQRT_PRICE) sqrtPriceLimitX96 = MIN_SQRT_PRICE_PLUS_ONE;
    } else {
      sqrtPriceLimitX96 = currentSqrtPriceX96 + 1n;
      if (sqrtPriceLimitX96 >= MAX_SQRT_PRICE) {
        const result: SwapResult = {
          success: false,
          amountIn,
          error:
            'Pool price at maximum; cannot swap token1->token0. Re-create pool with normal initial price (e.g. 1:1).',
        };
        return JSON.stringify(result);
      }
    }
  } else {
    sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE;
  }

  const reportPayloadHex = encodeSwapReport({
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
    zeroForOne,
    amountIn,
    amountOutMin,
    hookData,
    recipient,
    deadline,
    poolSwapTestAddress: config.poolSwapTestAddress,
    poolManagerAddress: config.poolManagerAddress,
    sqrtPriceLimitX96,
  });

  runtime.log(
    `V4 swap: currency0=${currency0} currency1=${currency1} zeroForOne=${zeroForOne} amountIn=${amountIn} amountOutMin=${amountOutMin} recipient=${recipient} deadline=${deadline}`,
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
      receiver: config.swapReceiverAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: config.gasLimit,
      },
    })
    .result();

  const txStatus = resp.txStatus;
  const txHash = resp.txHash ? bytesToHex(resp.txHash) : undefined;

  if (txStatus !== TxStatus.SUCCESS) {
    const result: SwapResult = {
      success: false,
      amountIn,
      error: resp.errorMessage ?? `tx status: ${txStatus}`,
    };
    return JSON.stringify(result);
  }

  runtime.log(`Swap tx succeeded: ${txHash}`);

  const result: SwapResult = {
    success: true,
    txHash,
    amountIn,
    amountOut: amountOutMin,
  };
  return JSON.stringify(result);
}

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Running Uniswap V4 swap (cron trigger)');
  return doSwap(runtime);
};

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log('Running Uniswap V4 swap (HTTP trigger)');
  if (payload.input && payload.input.length > 0) {
    try {
      const body = decodeJson(payload.input);
      runtime.log(`HTTP body: ${JSON.stringify(body)}`);
    } catch {
      // ignore parse errors; use runtime.config
    }
  }
  return doSwap(runtime);
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

main();
