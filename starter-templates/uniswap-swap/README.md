# Uniswap Swap - CRE Starter Template

Config-driven CRE workflow that performs a **Uniswap V4 token swap** on a single chain. Config shape is aligned for FlowForge workflows that can be invoked from the app with the same config.

---

## What This Template Does

- **Trigger:** Cron (scheduled) or HTTP (one-off invocation from an app).
- **Execution:** CRE report + **SwapReceiver** contract. The workflow encodes swap params and submits a report; the **SwapReceiver** pulls tokens from the recipient, approves PoolManager, and calls [Uniswap V4 PoolSwapTest](https://github.com/Uniswap/v4-core/blob/main/src/test/PoolSwapTest.sol) for the swap.
- **Result:** Returns `{ success, txHash?, amountIn, amountOut?, error? }` so the backend can map to `NodeExecutionOutput` / `SwapExecutionResult`.

---

## Config Shape (aligned with agentic)

- `chain`: e.g. `ARBITRUM`, `ARBITRUM_SEPOLIA`
- `chainSelectorName`: CRE chain selector (e.g. `ethereum-mainnet-arbitrum-1`, `ethereum-testnet-sepolia-arbitrum-1`)
- `provider`: `"UNISWAP"`
- `swapReceiverAddress`: Deployed **SwapReceiver** contract address (required).
- `poolSwapTestAddress`: Uniswap V4 PoolSwapTest address for the chain (testnets only; mainnets may use a different router).
- `poolManagerAddress`: Uniswap V4 PoolManager address for the chain.
- `gasLimit`: Gas limit for the writeReport tx.
- `poolConfig`: V4 pool identification (optional; defaults: fee 3000, tickSpacing 60, no hooks).
  - `fee`: uint24 (e.g. 3000 = 0.3%)
  - `tickSpacing`: int24 (e.g. 60 for 0.3% fee tier)
  - `hooks`: address (IHooks; use `0x0000000000000000000000000000000000000000` for pools without hooks)
- `inputConfig`:
  - `sourceToken`: `{ address, symbol?, decimals? }`
  - `destinationToken`: `{ address, symbol?, decimals? }`
  - `amount`: string (wei/smallest unit)
  - `swapType`: `"EXACT_INPUT"` | `"EXACT_OUTPUT"`
  - `walletAddress`: Recipient (and payer of tokenIn via approval to SwapReceiver).
  - `slippageTolerance?`: number (default 0.5)
  - `deadline?`: unix timestamp
  - `amountOutMinimum?`: (EXACT_INPUT) minimum amount out; set from a prior quote or leave 0 for testing.
  - `amountInMaximum?`: (EXACT_OUTPUT) maximum amount in.
- `schedule`: 6-field cron (for cron trigger).
- `simulateFirst?`: boolean (optional).

**Currency ordering and zeroForOne:** V4 pools use `currency0` and `currency1` sorted by address (currency0 < currency1). The workflow derives `zeroForOne` from your source/destination: `zeroForOne = true` means swapping currency0 → currency1; `false` means currency1 → currency0.

---

## V4 Fee Structure

Uniswap V4 applies **protocol fee** first, then **LP fee** to the remainder. The total swap fee is slightly less than the simple sum of both. V4 supports unlimited static fee tiers and dynamic fees (indicated by fee = `0x800000`). See [Uniswap V4 fee docs](https://docs.uniswap.org/contracts/v4/concepts/fee%20structure).

---

## V4 Contract Addresses (Arbitrum Sepolia)

| Contract | Address |
| -------- | ------- |
| PoolManager | `0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317` |
| PoolSwapTest | `0xf3a39c86dbd13c45365e57fb90fe413371f65af8` |

See [Uniswap V4 Deployments](https://docs.uniswap.org/contracts/v4/deployments) for other chains.

---

## Setup

### 1. Deploy SwapReceiver to Arbitrum Sepolia

Deploy the **SwapReceiver** contract so the CRE workflow has an on-chain receiver to send reports to. Users must **approve** this contract for `tokenIn` (source currency) before the workflow runs.

**Prerequisites**

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `cast`)
- ETH on Arbitrum Sepolia for gas

**Steps**

1. **Go to the contracts directory**

   ```bash
   cd cre-templates/starter-templates/uniswap-swap/contracts
   ```

2. **Initialize submodules** (uniswap-hooks, hookmate, forge-std)

   ```bash
   git submodule update --init --recursive
   ```

3. **Set your deployer private key** (wallet that will pay gas)

   ```bash
   export PRIVATE_KEY=0x...   # Your deployer private key (keep secret)
   ```

4. **Deploy SwapReceiver to Arbitrum Sepolia**

   ```bash
   forge script scripts/DeploySwapReceiver.s.sol:DeploySwapReceiver \
     --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
     --broadcast \
     --chain-id 421614 \
     --verify --verifier-api-key $ETHERSCAN_API_KEY
   ```

5. **Copy the deployed address** from the log (`SwapReceiver deployed at: 0x...`) and set it in the workflow config.

See [UNISWAP_SWAP_WORKFLOW_RUN_STEPS.md](../../../docs/UNISWAP_SWAP_WORKFLOW_RUN_STEPS.md) for full run steps (deploy, config, approvals, test).

### 2. Run a swap (Arbitrum Sepolia)

SwapReceiver only moves **ERC20** tokens (`transferFrom`). Native ETH must be wrapped to WETH first.

**Before you broadcast:** The wallet set in `inputConfig.walletAddress` must (1) hold at least `inputConfig.amount` of the **source token** (e.g. WETH), and (2) have **approved** the SwapReceiver contract to spend that token. If either is missing, the on-chain tx will revert (see [Troubleshooting](#troubleshooting) below).

**Step A – Wrap ETH to WETH**

Use the WETH contract on Arbitrum Sepolia (`0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`):

- **Option 1 (cast):**  
  `cast send 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73 "deposit()" --value 0.1ether --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key $PRIVATE_KEY`
- **Option 2:** Call `deposit()` with value (e.g. 0.1 ETH) from your wallet (Arbiscan, Metamask, etc.).

**Step B – Approve SwapReceiver to spend WETH**

Allow the deployed SwapReceiver to pull WETH from your wallet:

```bash
cast send 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73 \
  "approve(address,uint256)" <SWAP_RECEIVER_ADDRESS> 115792089237316195423570985008687907853269984665640564039457584007913129639935 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key $PRIVATE_KEY
```

(Or approve a specific amount, e.g. `100000000000000000` for 0.1 WETH.)

**Step C – Set your wallet and SwapReceiver in the workflow config**

Edit `uniswap-swap-ts/workflow/config.staging.json`:

- Set `swapReceiverAddress` to your deployed SwapReceiver address.
- Set `inputConfig.walletAddress` to the **same** wallet you used in Step A and B (the one that holds WETH and approved SwapReceiver).
- Ensure `poolConfig` matches the V4 pool you want to swap on (fee, tickSpacing, hooks). For pools without hooks, use `hooks: "0x0000000000000000000000000000000000000000"`.

**Step D – Run the workflow**

From the workflow directory:

```bash
cd uniswap-swap-ts
bun install   # or npm install
cre workflow simulate workflow --target staging-settings --trigger-index 1 --non-interactive --http-payload '{}'
```

`--trigger-index 1` uses the HTTP trigger (one-off). For a scheduled run you'd use the cron trigger (index 0).

**Note:** `cre workflow simulate` runs in simulation mode. To actually submit the report on-chain you need a CRE environment that broadcasts (e.g. registered workflow and DON). Check [CRE docs](https://docs.chain.link/cre) for running in a live environment.

### 3. Configure workflow (reference)

- Set `swapReceiverAddress` in `workflow/config.staging.json` to your deployed SwapReceiver address.
- Set `inputConfig.sourceToken`, `destinationToken`, `amount`, `walletAddress`, and optionally `amountOutMinimum` (recommended for EXACT_INPUT).
- Set `poolConfig` to match the target V4 pool (fee, tickSpacing, hooks).

### 4. RPC and secrets

- Configure RPC endpoints in `project.yaml` (or use defaults).
- For local simulation, no private key is required (report/receiver flow uses DON consensus).

---

## Troubleshooting

- **`ERC20: transfer amount exceeds balance`**  
  The wallet in `inputConfig.walletAddress` does not hold enough of the **source token** (e.g. WETH). Fix: fund that wallet with the source token (wrap ETH to WETH if using WETH), then run again. Ensure the balance is at least `inputConfig.amount` (in wei/smallest unit).

- **`ERC20: insufficient allowance`**  
  The wallet has not approved the SwapReceiver contract to spend the source token. Fix: run Step B (approve) for the wallet that is set in `walletAddress`.

- **Simulation says "Swap tx succeeded" but the chain tx reverted**  
  The CRE CLI may return a tx hash when the report was submitted; the actual revert happens inside the receiver contract (e.g. balance/allowance). Always check the tx on Arbiscan. Ensure the recipient wallet is funded and approved before broadcasting.

- **Pool not found or swap reverts**  
  Ensure `poolConfig` (fee, tickSpacing, hooks) matches an existing V4 pool for the source/destination token pair. The pool must be initialized on the target chain. For Arbitrum Sepolia, see [Create USDC/WETH Pool](../../../docs/CREATE_USDC_WETH_POOL_ARB_SEPOLIA.md) to create the pool and add liquidity.

- **`STF` or "out of gas"**  
  The tx ran out of gas during the swap. Fix: increase `gasLimit` in the workflow config (e.g. to 550000–600000 for a single-hop swap).

---

## Structure

- `uniswap-swap-ts/`: TypeScript workflow
  - `workflow/`: main.ts, workflow.yaml, config.staging.json, config.production.json, package.json
  - `contracts/abi/`: IERC20
- `contracts/`: SwapReceiver.sol and keystone interfaces (IReceiver, IERC165)
  - `lib/`: uniswap-hooks (v4-core, v4-periphery), hookmate, forge-std

---

## Compatibility

Config is compatible for FlowForge workflows that can be invoked from the app with the same config.

---

## License

MIT — see the repository [LICENSE](../../LICENSE).
