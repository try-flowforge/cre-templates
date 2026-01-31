# Uniswap Swap - CRE Starter Template

Config-driven CRE workflow that performs a **Uniswap V3 token swap** on a single chain. Config shape is aligned for FlowForge workflows that can be invoked from the app with the same config.

---

## What This Template Does

- **Trigger:** Cron (scheduled) or HTTP (one-off invocation from an app).
- **Execution:** CRE report + **SwapReceiver** contract. The workflow encodes swap params (tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, deadline, router) and submits a report; the **SwapReceiver** contract decodes the report, pulls tokens from the recipient, and calls Uniswap V3 SwapRouter02 `exactInputSingle`.
- **Result:** Returns `{ success, txHash?, amountIn, amountOut?, error? }` so the backend can map to `NodeExecutionOutput` / `SwapExecutionResult`.

---

## Config Shape (aligned with agentic)

- `chain`: e.g. `ARBITRUM`, `ARBITRUM_SEPOLIA`
- `chainSelectorName`: CRE chain selector (e.g. `ethereum-mainnet-arbitrum-1`, `ethereum-testnet-sepolia-arbitrum-1`)
- `provider`: `"UNISWAP"`
- `swapReceiverAddress`: Deployed **SwapReceiver** contract address (required).
- `routerAddress`: Uniswap V3 SwapRouter02 address for the chain.
- `quoterAddress`: (optional) QuoterV2 for quotes; workflow can use `amountOutMinimum` from config instead.
- `gasLimit`: Gas limit for the writeReport tx.
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

---

## Setup

### 1. Deploy SwapReceiver to Arbitrum Sepolia

Deploy the **SwapReceiver** contract so the CRE workflow has an on-chain receiver to send reports to. Users must **approve** this contract for `tokenIn` before the workflow runs.

**Prerequisites**

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `cast`)
- ETH on Arbitrum Sepolia for gas

**Steps**

1. **Go to the contracts directory**

   ```bash
   cd cre-templates/starter-templates/uniswap-swap/contracts
   ```

2. **Install Forge standard library** (if not already present)

   Either clone it (avoids git submodule issues):

   ```bash
   mkdir -p lib
   git clone https://github.com/foundry-rs/forge-std lib/forge-std
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

5. **Copy the deployed address** from the log (`SwapReceiver deployed at: 0x...`) and set it in the workflow config (see step 2 below).

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
  "approve(address,uint256)" 0x9A48d70a5DD7DcE58A297bb0acFfEB14D7C77085 115792089237316195423570985008687907853269984665640564039457584007913129639935 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key $PRIVATE_KEY
```

(Or approve a specific amount, e.g. `100000000000000000` for 0.1 WETH.)

**Step C – Set your wallet in the workflow config**

Edit `uniswap-swap-ts/workflow/config.staging.json` and set `inputConfig.walletAddress` to the **same** wallet you used in Step A and B (the one that holds WETH and approved SwapReceiver). The config already has:

- `swapReceiverAddress`: `0x9A48d70a5DD7DcE58A297bb0acFfEB14D7C77085`
- Example: WETH → USDC, amount `100000000000000000` (0.1 WETH), `amountOutMinimum`: `"0"` (use a real quote in production).

**Step D – Run the workflow**

From repo root:

```bash
cd cre-templates/starter-templates/uniswap-swap/uniswap-swap-ts/workflow
bun install   # or npm install
cre workflow simulate workflow --target staging-settings --trigger-index 1 --non-interactive --http-payload '{}'
```

`--trigger-index 1` uses the HTTP trigger (one-off). For a scheduled run you’d use the cron trigger (index 0).

**Note:** `cre workflow simulate` runs in simulation mode. To actually submit the report on-chain you need a CRE environment that broadcasts (e.g. registered workflow and DON). Check [CRE docs](https://docs.chain.link/cre) for running in a live environment.

### 3. Configure workflow (reference)

- Set `swapReceiverAddress` in `workflow/config.staging.json` to your deployed SwapReceiver address (already set above).
- Set `inputConfig.sourceToken`, `destinationToken`, `amount`, `walletAddress`, and optionally `amountOutMinimum` (recommended for EXACT_INPUT).

### 4. RPC and secrets

- Configure RPC endpoints in `project.yaml` (or use defaults).
- For local simulation, no private key is required (report/receiver flow uses DON consensus).

### 5. Install and run

From the **project root** (where `project.yaml` is):

```bash
cd uniswap-swap-ts/workflow
bun install   # or npm install
cre workflow simulate workflow --target staging-settings
```

For HTTP trigger (one-off):

```bash
cre workflow simulate workflow --target staging-settings --trigger-index 1 --non-interactive --http-payload '{}'
```

---

## Troubleshooting

If you run with `--broadcast` and the transaction reverts when you inspect it on Arbiscan:

- **`ERC20: transfer amount exceeds balance`**  
  The wallet in `inputConfig.walletAddress` does not hold enough of the **source token** (e.g. WETH). Fix: fund that wallet with the source token (wrap ETH to WETH if using WETH), then run again. Ensure the balance is at least `inputConfig.amount` (in wei/smallest unit).

- **`ERC20: insufficient allowance`** (if you see this instead)  
  The wallet has not approved the SwapReceiver contract to spend the source token. Fix: run Step B (approve) for the wallet that is set in `walletAddress`.

- **Simulation says "Swap tx succeeded" but the chain tx reverted**  
  The CRE CLI may return a tx hash when the report was submitted; the actual revert happens inside the receiver contract (e.g. balance/allowance). Always check the tx on Arbiscan. Ensure the recipient wallet is funded and approved before broadcasting.

- **`STF` or "out of gas: not enough gas for reentrancy sentry"**  
  The tx ran out of gas during the swap (often when the router pulls the input token from the receiver into the pool). No address is "low on gas" — the **gas limit** for the writeReport tx was too low. Fix: increase `gasLimit` in the workflow config (e.g. to 500000–600000 for a single-hop swap).

---

## Structure

- `uniswap-swap-ts/`: TypeScript workflow
  - `workflow/`: main.ts, workflow.yaml, config.staging.json, config.production.json, package.json
  - `contracts/abi/`: IERC20, QuoterV2 (for optional quote)
- `contracts/src/`: SwapReceiver.sol and keystone interfaces (IReceiver, IERC165)

---

## Compatibility

Config is compatible for FlowForge workflows that can be invoked from the app with the same config.

---

## License

MIT — see the repository [LICENSE](../../LICENSE).
