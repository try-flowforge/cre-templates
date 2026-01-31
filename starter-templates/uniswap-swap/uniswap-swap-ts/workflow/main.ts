/**
 * Uniswap swap CRE workflow (TypeScript).
 * Config shape aligned with agentic SwapNodeConfig / SwapInputConfig for future invocation from the app.
 * Trigger: cron (scheduled) or HTTP (one-off from app). Executes swap via CRE report + receiver contract.
 */

import {
  bytesToHex,
  cre,
  decodeJson,
  getNetwork,
  hexToBase64,
  Runner,
  type Runtime,
  type CronPayload,
  type HTTPPayload,
  TxStatus,
} from '@chainlink/cre-sdk';
import { type Address, encodeAbiParameters, parseAbiParameters } from 'viem';
import { z } from 'zod';

// ---------- Config schema (aligned with agentic SwapNodeConfig / SwapInputConfig) ----------

const tokenInfoSchema = z.object({
  address: z.string(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
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
  routerAddress: z.string(),
  quoterAddress: z.string().optional(),
  gasLimit: z.string(),
  inputConfig: inputConfigSchema,
  simulateFirst: z.boolean().optional(),
  feeTier: z.number().optional(),
});

type Config = z.infer<typeof configSchema>;

// Uniswap V3 default fee tier (0.3%)
const DEFAULT_FEE_TIER = 3000;

// Default deadline: 20 minutes from now (set at execution time)
const DEFAULT_DEADLINE_SECONDS = 20 * 60;

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
 * Encode swap report payload for receiver contract.
 * Receiver decodes: (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMin, deadline, routerAddress).
 */
function encodeSwapReport(params: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: string;
  amountOutMin: string;
  deadline: number;
  routerAddress: string;
}): string {
  return encodeAbiParameters(
    parseAbiParameters(
      'address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMin, uint256 deadline, address routerAddress',
    ),
    [
      params.tokenIn as Address,
      params.tokenOut as Address,
      params.fee,
      params.recipient as Address,
      BigInt(params.amountIn),
      BigInt(params.amountOutMin),
      BigInt(params.deadline),
      params.routerAddress as Address,
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

  const chainSelectorName = config.chainSelectorName;
  const isTestnetChain = isTestnet(config.chain);
  const evmClient = getEvmClient(chainSelectorName, isTestnetChain);

  const tokenIn = config.inputConfig.sourceToken.address;
  const tokenOut = config.inputConfig.destinationToken.address;
  const amountIn = config.inputConfig.amount;
  const recipient = config.inputConfig.walletAddress;
  const slippageTolerance = config.inputConfig.slippageTolerance ?? 0.5;
  const feeTier = config.feeTier ?? DEFAULT_FEE_TIER;

  let amountOutMin = '0';
  if (config.inputConfig.swapType === 'EXACT_INPUT') {
    amountOutMin = config.inputConfig.amountOutMinimum ?? '0';
    if (amountOutMin === '0' && config.quoterAddress) {
      runtime.log('amountOutMinimum not set; using 0 (no slippage protection). Set amountOutMinimum in config or use quoter.');
    }
  }
  const amountInMax = config.inputConfig.amountInMaximum ?? '0';

  const deadline = config.inputConfig.deadline
    ? config.inputConfig.deadline
    : Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;

  const reportPayloadHex = encodeSwapReport({
    tokenIn,
    tokenOut,
    fee: feeTier,
    recipient,
    amountIn,
    amountOutMin,
    deadline,
    routerAddress: config.routerAddress,
  });

  runtime.log(
    `Swap report: tokenIn=${tokenIn} tokenOut=${tokenOut} amountIn=${amountIn} amountOutMin=${amountOutMin} recipient=${recipient} deadline=${deadline}`,
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
  runtime.log('Running Uniswap swap (cron trigger)');
  return doSwap(runtime);
};

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log('Running Uniswap swap (HTTP trigger)');
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
