import {
    decodeJson,
    Runner,
    type Runtime,
    type CronPayload,
    type HTTPPayload,
    consensusIdenticalAggregation,
    type HTTPSendRequester,
    handler,
    CronCapability,
    HTTPCapability,
    HTTPClient
} from '@chainlink/cre-sdk';

import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

// ---------- Config schema ----------

const configSchema = z.object({
    schedule: z.string(),
    network: z.enum(['testnet', 'mainnet']),
    market: z.string(),
    side: z.enum(['long', 'short']),
    collateral: z.number(),
    leverage: z.number(),
    traderAddress: z.string(),
    serviceUrl: z.string(),
    slPrice: z.number().optional(),
    tpPrice: z.number().optional()
});

type Config = z.infer<typeof configSchema>;

export type OstiumTradeResult = {
    success: boolean;
    txHash?: string;
    error?: string;
};

// ---------- HMAC Signing Logic ----------

/**
 * Creates an HMAC-SHA256 signature conforming to flowforge-ostium-service requirements.
 */
function signRequest(
    secret: string,
    method: string,
    path: string,
    body: string,
    timestamp: string
): string {
    const payloadStr = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
    const mac = hmac(sha256, utf8ToBytes(secret), utf8ToBytes(payloadStr));
    return bytesToHex(mac);
}

// ---------- API Request to Ostium Service ----------

type OstiumTradePayload = Config & { hmacSecret: string };

const sendOstiumOpenRequest = (sendRequester: HTTPSendRequester, payload: OstiumTradePayload): string => {
    const path = '/v1/positions/open';
    const url = `${payload.serviceUrl}${path}`;

    // Construct the payload matching OstiumPositionOpenRequest
    const payloadObj = {
        network: payload.network,
        market: payload.market,
        side: payload.side,
        collateral: payload.collateral,
        leverage: payload.leverage,
        traderAddress: payload.traderAddress,
        ...(payload.slPrice != null ? { slPrice: payload.slPrice } : {}),
        ...(payload.tpPrice != null ? { tpPrice: payload.tpPrice } : {}),
    };

    // Convert body to string for signing
    const bodyStr = JSON.stringify(payloadObj);

    // Generate HMAC signature using @noble/hashes
    const timestamp = Date.now().toString();
    const signature = signRequest(payload.hmacSecret, 'POST', path, bodyStr, timestamp);

    const req = {
        url,
        method: 'POST' as const,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-timestamp': timestamp,
            'x-signature': signature
        },
        body: Buffer.from(bodyStr).toString('base64')
    };

    const resp = sendRequester.sendRequest(req).result();
    return Buffer.from(resp.body).toString('utf-8');
};

// ---------- Workflow Logic ----------

function openOstiumPosition(runtime: Runtime<Config>, dynamicConfigOverride?: Partial<Config>): string {
    const config = {
        ...runtime.config,
        ...dynamicConfigOverride,
    } as Config;

    runtime.log(`Preparing to open Ostium position: ${config.side} ${config.market} with ${config.collateral} USDC @ ${config.leverage}x`);

    const secretResp = runtime.getSecret({ id: 'OSTIUM_HMAC_SECRET' }).result();
    const hmacSecret = secretResp.value;

    if (!hmacSecret) {
        runtime.log('Failed to execute request: OSTIUM_HMAC_SECRET secret is missing.');
        return JSON.stringify({
            success: false,
            error: 'Missing OSTIUM_HMAC_SECRET'
        });
    }

    const tradePayload: OstiumTradePayload = { ...config, hmacSecret };

    const httpClient = new HTTPClient();

    let responseDataParsed: any;
    try {
        const resultString = httpClient
            .sendRequest(
                runtime,
                sendOstiumOpenRequest,
                consensusIdenticalAggregation<string>()
            )(tradePayload)
            .result();

        runtime.log(`Raw Ostium Service Response: ${resultString}`);
        responseDataParsed = JSON.parse(resultString);
    } catch (err: any) {
        runtime.log(`Failed to execute request: ${err.message}`);
        return JSON.stringify({
            success: false,
            error: `Failed to execute request: ${err.message}`
        });
    }

    if (responseDataParsed?.success) {
        const txHash = responseDataParsed?.data?.result?.receipt?.transactionHash
            || responseDataParsed?.data?.txHash
            || 'unknown';
        runtime.log(`Position opened successfully! Tx Hash: ${txHash}`);
        const result: OstiumTradeResult = {
            success: true,
            txHash,
        };
        return JSON.stringify(result);
    }

    const errorMessage = responseDataParsed?.error?.message || 'Unknown error occurred from Ostium Service';
    runtime.log(`Error opening position: ${errorMessage}`);
    return JSON.stringify({
        success: false,
        error: errorMessage
    });
}

// ---------- Handlers ----------

const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
    runtime.log('Running Ostium Trade (cron trigger)');
    return openOstiumPosition(runtime);
};

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
    runtime.log('Running Ostium Trade (HTTP trigger)');

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

    return openOstiumPosition(runtime, dynamicConfigOverride);
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
