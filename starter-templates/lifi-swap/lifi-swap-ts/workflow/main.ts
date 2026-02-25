import {
    bytesToHex,
    decodeJson,
    getNetwork,
    hexToBase64,
    Runner,
    type Runtime,
    type CronPayload,
    type HTTPPayload,
    TxStatus,
    consensusIdenticalAggregation,
    type HTTPSendRequester,
    handler,
    CronCapability,
    HTTPCapability,
    HTTPClient,
    EVMClient
} from '@chainlink/cre-sdk';

import { type Address, encodeAbiParameters, parseAbiParameters } from 'viem';
import { z } from 'zod';

// ---------- Config schema ----------

const tokenInfoSchema = z.object({
    address: z.string(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
});

const inputConfigSchema = z.object({
    sourceToken: tokenInfoSchema,
    destinationToken: tokenInfoSchema,
    amount: z.string(), // raw amount string
    swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT']),
    walletAddress: z.string(),
    slippageTolerance: z.number().optional(),
});

const configSchema = z.object({
    schedule: z.string(),
    chain: z.string(),
    chainSelectorName: z.string(),
    provider: z.literal('LIFI'),
    swapReceiverAddress: z.string(),
    gasLimit: z.string(),
    inputConfig: inputConfigSchema,
});

type Config = z.infer<typeof configSchema>;

export type LifiSwapResult = {
    success: boolean;
    txHash?: string;
    amountIn: string;
    amountOut?: string;
    error?: string;
};

// Map FlowForge SupportedChains to LI.FI chain IDs (Arbitrum=42161)
function getLifiChainId(chain: string): number {
    switch (chain) {
        case 'ARBITRUM': return 42161;
        case 'ARBITRUM_SEPOLIA': return 421614;
        default: return 42161; // fallback
    }
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
    return new EVMClient(network.chainSelector.selector);
}

function isTestnet(chain: string): boolean {
    return chain === 'ARBITRUM_SEPOLIA' || chain.toLowerCase().includes('sepolia');
}

/**
 * Encodes the LifiReceiver `onReport` payload.
 * (address target, bytes callData, uint256 value, address tokenIn, uint256 amountIn, address recipient)
 */
function encodeSwapReport(params: {
    target: string;
    callData: string;
    value: string;
    tokenIn: string;
    amountIn: string;
    recipient: string;
}): string {
    return encodeAbiParameters(
        parseAbiParameters(
            'address target, bytes callData, uint256 value, address tokenIn, uint256 amountIn, address recipient',
        ),
        [
            params.target as Address,
            params.callData as `0x${string}`,
            BigInt(params.value),
            params.tokenIn as Address,
            BigInt(params.amountIn),
            params.recipient as Address,
        ],
    );
}

// ---------- API Request for LI.FI Quote ----------

const fetchLifiQuote = (sendRequester: HTTPSendRequester, config: Config): string => {
    const chainId = getLifiChainId(config.chain);
    const inputConfig = config.inputConfig;

    // e.g. 0.5% needs to be passed as 0.005 in LI.FI
    const slippageParam = (inputConfig.slippageTolerance || 0.5) / 100;

    // Construct search params manually for HTTP capability
    const paramsList = [
        `fromChain=${chainId}`,
        `toChain=${chainId}`,
        `fromToken=${inputConfig.sourceToken.address}`,
        `toToken=${inputConfig.destinationToken.address}`,
        `fromAmount=${inputConfig.amount}`,
        `fromAddress=${inputConfig.walletAddress}`,
        `slippage=${slippageParam}`,
        `integrator=flowforge-cre-template`
    ];

    const url = `https://li.quest/v1/quote?${paramsList.join('&')}`;

    const req = {
        url,
        method: 'GET' as const,
        headers: {
            'Accept': 'application/json',
        },
    };

    const resp = sendRequester.sendRequest(req).result();
    const rawData = new TextDecoder().decode(resp.body);

    // The workflow handler parses the JSON, so simply return the string representation
    return rawData;
};

// ---------- Workflow Logic ----------

function doSwap(runtime: Runtime<Config>, dynamicConfigOverride?: Partial<Config>): string {
    const config = {
        ...runtime.config,
        ...dynamicConfigOverride,
        inputConfig: {
            ...runtime.config.inputConfig,
            ...(dynamicConfigOverride?.inputConfig || {})
        }
    } as Config;

    if (!config.swapReceiverAddress || config.swapReceiverAddress === '') {
        return JSON.stringify({
            success: false,
            amountIn: config.inputConfig.amount,
            error: 'swapReceiverAddress is required; deploy LifiReceiver and set in config',
        });
    }

    // 1. Fetch quote from LI.FI
    runtime.log('Fetching quote from LI.FI API...');
    const httpClient = new HTTPClient();

    let quoteDataParsed: any;
    try {
        const quoteStringResult = httpClient
            .sendRequest(
                runtime,
                fetchLifiQuote,
                consensusIdenticalAggregation<string>()
            )(config)
            .result();

        runtime.log(`Raw LI.FI Response: ${quoteStringResult}`);
        quoteDataParsed = JSON.parse(quoteStringResult);
    } catch (err: any) {
        runtime.log(`Failed to fetch quote: ${err.message}`);
        return JSON.stringify({
            success: false,
            amountIn: config.inputConfig.amount,
            error: `Failed to fetch quote: ${err.message}`
        });
    }

    const txRequest = quoteDataParsed?.transactionRequest;
    const estimate = quoteDataParsed?.estimate;

    if (!txRequest || !txRequest.to || !txRequest.data) {
        return JSON.stringify({
            success: false,
            amountIn: config.inputConfig.amount,
            error: 'LI.FI response did not include valid transactionRequest data. Check token config.'
        });
    }

    runtime.log(`Quote received. Expected Output: ${estimate?.toAmount}`);

    // 2. Prepare payload for EVM writeReport
    const recipient = config.inputConfig.walletAddress;
    // If native token is used as source, pass zero address to our receiver
    const isNativeSource = config.inputConfig.sourceToken.address.toLowerCase() === '0x0000000000000000000000000000000000000000' ||
        config.inputConfig.sourceToken.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const tokenInPass = isNativeSource ? '0x0000000000000000000000000000000000000000' : config.inputConfig.sourceToken.address;
    const valuePass = txRequest.value || '0';

    const reportPayloadHex = encodeSwapReport({
        target: txRequest.to,
        callData: txRequest.data,
        value: valuePass,
        tokenIn: tokenInPass,
        amountIn: config.inputConfig.amount,
        recipient: recipient,
    });

    runtime.log(`Encoded LifiReceiver report. Submitting to EVM via CRE writeReport...`);

    // 3. Write on-chain 
    const chainSelectorName = config.chainSelectorName;
    const isTestnetChain = isTestnet(config.chain);
    const evmClient = getEvmClient(chainSelectorName, isTestnetChain);

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
        const result: LifiSwapResult = {
            success: false,
            amountIn: config.inputConfig.amount,
            error: resp.errorMessage ?? `tx status: ${txStatus}`,
        };
        return JSON.stringify(result);
    }

    let explorerLink = '';
    if (txHash) {
        const formattedTxHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
        explorerLink = config.chain === 'ARBITRUM'
            ? `https://arbiscan.io/tx/${formattedTxHash}`
            : `https://sepolia.arbiscan.io/tx/${formattedTxHash}`;
        runtime.log(`Swap executed! Tx Hash: ${formattedTxHash} | Explorer Link: ${explorerLink}`);
    } else {
        runtime.log(`Swap executed successfully!`);
    }

    const result: LifiSwapResult = {
        success: true,
        txHash,
        amountIn: config.inputConfig.amount,
        amountOut: estimate?.toAmount || '0',
    };
    return JSON.stringify(result);
}

// ---------- Handlers ----------

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
    runtime.log('Running LI.FI swap (cron trigger)');
    return doSwap(runtime);
};

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
    runtime.log('Running LI.FI swap (HTTP trigger)');

    let dynamicConfigOverride: Partial<Config> | undefined;

    if (payload.input && payload.input.length > 0) {
        try {
            const body = decodeJson(payload.input);
            runtime.log(`HTTP dynamic payload received: ${JSON.stringify(body)}`);
            dynamicConfigOverride = body as Partial<Config>;
        } catch (err: any) {
            runtime.log(`Failed to parse HTTP payload input. Using default config. Error: ${err.message}`);
        }
    }

    return doSwap(runtime, dynamicConfigOverride);
};

const initWorkflow = (config: Config) => {
    const cron = new CronCapability();
    const httpTrigger = new HTTPCapability();

    return [
        handler(
            cron.trigger({
                schedule: config.schedule,
            }),
            onCronTrigger,
        ),
        handler(httpTrigger.trigger({}), onHttpTrigger),
    ];
};

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema });
    await runner.run(initWorkflow);
}

