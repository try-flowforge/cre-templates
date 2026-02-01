#!/usr/bin/env bun
/**
 * Create USDC/WETH Uniswap V4 pool on Arbitrum Sepolia using PositionManager.
 *
 * Uses PositionManager (not PoolModifyLiquidityTest) with Permit2 for token transfers.
 * No WETH wrapping — assumes you already have WETH.
 *
 * Loads .env from the same directory:
 *   ALCHEMY_API_KEY=<your Alchemy API key>
 *   PRIVATE_KEY=0x<your private key>
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hash,
} from "viem";
import { TickMath, maxLiquidityForAmounts } from "@uniswap/v3-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

// Arbitrum Sepolia (Uniswap V4)
const POOL_MANAGER = "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317" as Address;
const POSITION_MANAGER = "0xAc631556d3d4019C95769033B5E719dD77124BAc" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const WETH = "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" as Address;
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address;

const FEE = 500;
const TICK_SPACING = 10;
const HOOKS = "0x0000000000000000000000000000000000000000" as Address;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

const TICK_LOWER = -120;
const TICK_UPPER = 120;
const AMOUNT0_RAW = 10_000_000n; // 10 USDC
const AMOUNT1_RAW = 5_000_000_000_000_000n; // 0.005 WETH
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const POOL_MANAGER_ABI = [
  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ type: "int24" }],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

const POSITION_MANAGER_ABI = [
  {
    name: "modifyLiquidities",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function parseArgs(): { privateKey: `0x${string}`; rpcUrl: string } {
  const args = process.argv.slice(2);
  const privateKey =
    process.env.PRIVATE_KEY ?? args[args.indexOf("--private-key") + 1];
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const explicitRpcUrl = args[args.indexOf("--rpc-url") + 1];
  const rpcUrl =
    process.env.RPC_URL ??
    explicitRpcUrl ??
    (alchemyKey
      ? `https://arb-sepolia.g.alchemy.com/v2/${alchemyKey}`
      : undefined);

  if (!privateKey || !rpcUrl) {
    console.error(`
Usage:
  Create .env with ALCHEMY_API_KEY and PRIVATE_KEY, then:
    bun run create-pool
Or: bun run create-pool -- --private-key 0x... --rpc-url https://...
`);
    process.exit(1);
  }
  return {
    privateKey: privateKey.startsWith("0x")
      ? (privateKey as `0x${string}`)
      : (`0x${privateKey}` as `0x${string}`),
    rpcUrl,
  };
}

function getPoolId(currency0: Address, currency1: Address): Hash {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, FEE, TICK_SPACING, HOOKS]
  );
  return keccak256(encoded);
}

function encodeModifyLiquidities(
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  amount0Max: bigint,
  amount1Max: bigint,
  recipient: Address,
  hookData: `0x${string}`
): `0x${string}` {
  // Actions: MINT_POSITION (0x02), CLOSE_CURRENCY (0x12), CLOSE_CURRENCY (0x12)
  const actions = "0x021212" as `0x${string}`;

  const mintParams = encodeAbiParameters(
    [
      { type: "tuple", components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ] },
      { type: "int24" },
      { type: "int24" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "address" },
      { type: "bytes" },
    ],
    [
      poolKey,
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      recipient,
      hookData,
    ]
  ) as `0x${string}`;

  const close0Params = encodeAbiParameters(
    [{ type: "address" }],
    [poolKey.currency0]
  ) as `0x${string}`;
  const close1Params = encodeAbiParameters(
    [{ type: "address" }],
    [poolKey.currency1]
  ) as `0x${string}`;

  const params = [mintParams, close0Params, close1Params];
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, params]
  );
  return unlockData as `0x${string}`;
}

async function main() {
  const { privateKey, rpcUrl } = parseArgs();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport,
  });

  console.log("Wallet:", address);

  // 1. Check balances
  const wethBalance = await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  const usdcBalance = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  console.log("WETH:", wethBalance.toString());
  console.log("USDC:", usdcBalance.toString(), "(6 decimals)");

  if (usdcBalance < AMOUNT0_RAW) {
    console.error(`Need at least ${Number(AMOUNT0_RAW) / 1e6} USDC. Get from https://faucet.circle.com/`);
    process.exit(1);
  }
  if (wethBalance < AMOUNT1_RAW) {
    console.error(`Need at least ${Number(AMOUNT1_RAW) / 1e18} WETH.`);
    process.exit(1);
  }

  const maxApproval = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

  // 2. Approve tokens to Permit2
  const usdcApproveHash = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [PERMIT2, maxApproval],
  });
  await publicClient.waitForTransactionReceipt({ hash: usdcApproveHash });
  const wethApproveHash = await walletClient.writeContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [PERMIT2, maxApproval],
  });
  await publicClient.waitForTransactionReceipt({ hash: wethApproveHash });
  console.log("Approved USDC and WETH to Permit2");

  // 3. Approve PositionManager in Permit2
  const expiration = MAX_UINT48;
  const permit2UsdcHash = await walletClient.writeContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "approve",
    args: [USDC, POSITION_MANAGER, MAX_UINT160, expiration],
  });
  await publicClient.waitForTransactionReceipt({ hash: permit2UsdcHash });
  const permit2WethHash = await walletClient.writeContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "approve",
    args: [WETH, POSITION_MANAGER, MAX_UINT160, expiration],
  });
  await publicClient.waitForTransactionReceipt({ hash: permit2WethHash });
  console.log("Approved PositionManager in Permit2");

  // 4. Initialize pool if needed
  const poolKey = {
    currency0: USDC,
    currency1: WETH,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: HOOKS,
  };
  const poolId = getPoolId(USDC, WETH);
  const stateViewAddr = "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb" as Address;

  let sqrtPriceX96: bigint;
  try {
    [sqrtPriceX96] = await publicClient.readContract({
      address: stateViewAddr,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [poolId],
    });
  } catch {
    sqrtPriceX96 = 0n;
  }

  if (sqrtPriceX96 === 0n) {
    console.log("Initializing pool at 1:1...");
    const initHash = await walletClient.writeContract({
      address: POOL_MANAGER,
      abi: POOL_MANAGER_ABI,
      functionName: "initialize",
      args: [poolKey, SQRT_PRICE_1_1],
    });
    await publicClient.waitForTransactionReceipt({ hash: initHash });
    sqrtPriceX96 = SQRT_PRICE_1_1;
    console.log("Pool initialized");
  }

  // 5. Compute liquidity
  const currentSqrtPrice = sqrtPriceX96 > 0n ? sqrtPriceX96 : SQRT_PRICE_1_1;
  const sqrtA = TickMath.getSqrtRatioAtTick(TICK_LOWER);
  const sqrtB = TickMath.getSqrtRatioAtTick(TICK_UPPER);
  const liquidity = maxLiquidityForAmounts(
    currentSqrtPrice.toString(),
    sqrtA,
    sqrtB,
    AMOUNT0_RAW.toString(),
    AMOUNT1_RAW.toString(),
    false
  );
  const liquidityBigInt = BigInt(liquidity.toString());
  const amount0Max = (1n << 128n) - 1n;
  const amount1Max = (1n << 128n) - 1n;

  // 6. Add liquidity via PositionManager
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const unlockData = encodeModifyLiquidities(
    poolKey,
    TICK_LOWER,
    TICK_UPPER,
    liquidityBigInt,
    amount0Max,
    amount1Max,
    MSG_SENDER,
    "0x" as `0x${string}`
  );

  console.log("Adding liquidity via PositionManager...");
  const txHash = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Liquidity added, tx:", txHash);

  const [finalSqrt, tick, , lpFee] = await publicClient.readContract({
    address: stateViewAddr,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
  });
  console.log("\nPool state: sqrtPriceX96:", finalSqrt.toString(), "tick:", tick, "lpFee:", lpFee);
  console.log('Pool ready. config.staging.json poolConfig: { "fee": 500, "tickSpacing": 10, "hooks": "0x0" }');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
