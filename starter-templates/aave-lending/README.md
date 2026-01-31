# Aave Lending - CRE Starter Template

Config-driven CRE workflow that performs a single **Aave V3 Pool** operation (supply, withdraw, borrow, repay) on a single chain. Config shape is aligned for FlowForge workflows that can be invoked from the app with the same config.

---

## What This Template Does

- **Trigger:** Cron (scheduled) or HTTP (one-off invocation from an app).
- **Execution:** CRE report + **AaveReceiver** contract. The workflow encodes operation params (operation, pool, asset, amount, wallet, onBehalfOf, etc.) and submits a report; the **AaveReceiver** contract decodes the report, pulls/pushes tokens, and calls the Aave V3 Pool (`supply`, `withdraw`, `borrow`, `repay`).
- **Result:** Returns `{ success, txHash?, operation, amount, error? }` so the backend can map to `NodeExecutionOutput` / `LendingExecutionResult`.

---

## Config Shape (aligned with agentic)

- `chain`: e.g. `ARBITRUM`, `ARBITRUM_SEPOLIA`
- `chainSelectorName`: CRE chain selector (e.g. `ethereum-mainnet-arbitrum-1`, `ethereum-testnet-sepolia-arbitrum-1`)
- `provider`: `"AAVE"`
- `aaveReceiverAddress`: Deployed **AaveReceiver** contract address (required).
- `poolAddress`: Aave V3 Pool address for the chain (or omit to use built-in mapping).
- `gasLimit`: Gas limit for the writeReport tx.
- `inputConfig`:
  - `operation`: `"SUPPLY"` | `"WITHDRAW"` | `"BORROW"` | `"REPAY"`
  - `asset`: `{ address, symbol?, decimals?, aTokenAddress? }` — `aTokenAddress` optional for WITHDRAW (workflow fetches from Pool if not set).
  - `amount`: string (wei/smallest unit)
  - `walletAddress`: Executor (from whom tokens are pulled / to whom tokens are sent).
  - `interestRateMode?`: `"STABLE"` | `"VARIABLE"` (for BORROW/REPAY; default `"VARIABLE"`)
  - `onBehalfOf?`: Address receiving aTokens (supply) or whose debt is affected (borrow/repay); defaults to `walletAddress`.
  - `referralCode?`: number (default 0)
- `schedule`: 6-field cron (for cron trigger).
- `simulateFirst?`: boolean (optional).

**Note:** `ENABLE_COLLATERAL` and `DISABLE_COLLATERAL` require the user to call the Aave Pool directly (`setUserUseReserveAsCollateral`), since that function uses `msg.sender` as the user. This workflow does not support those operations.

---

## Setup

### 1. Deploy AaveReceiver to Arbitrum Sepolia

Deploy the **AaveReceiver** contract so the CRE workflow has an on-chain receiver to send reports to. Users must **approve** this contract for the relevant token (underlying for supply/repay, aToken for withdraw) before the workflow runs.

**Prerequisites**

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `cast`)
- ETH on Arbitrum Sepolia for gas

**Steps**

1. **Go to the contracts directory**

   ```bash
   cd cre-templates/starter-templates/aave-lending/contracts
   ```

2. **Initialize submodules** (forge-std)

   ```bash
   git submodule update --init --recursive
   ```

3. **Set your deployer private key** (wallet that will pay gas)

   ```bash
   export PRIVATE_KEY=0x...   # Your deployer private key (keep secret)
   ```

4. **Deploy AaveReceiver to Arbitrum Sepolia**

   ```bash
   forge script scripts/DeployAaveReceiver.s.sol:DeployAaveReceiver \
     --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
     --broadcast \
     --chain-id 421614 \
     --verify --verifier-api-key $ETHERSCAN_API_KEY
   ```

5. **Copy the deployed address** from the log (`AaveReceiver deployed at: 0x...`) and set it in `aaveReceiverAddress` in the workflow config.

### 2. Approvals and wallet setup

**Before you broadcast:** The wallet set in `inputConfig.walletAddress` must hold the required tokens and have approved the AaveReceiver contract:

- **SUPPLY:** User holds underlying (e.g. USDC), approves AaveReceiver for that token.
- **WITHDRAW:** User holds aTokens, approves AaveReceiver for the aToken.
- **BORROW:** No prior approval; borrowed funds are forwarded to the wallet.
- **REPAY:** User holds the borrowed asset, approves AaveReceiver for that token.

**Example – Approve AaveReceiver for USDC (supply):**

```bash
cast send <USDC_ADDRESS> \
  "approve(address,uint256)" <AaveReceiver_ADDRESS> 115792089237316195423570985008687907853269984665640564039457584007913129639935 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key $PRIVATE_KEY
```

### 3. Configure and run the workflow

Edit `aave-lending-ts/workflow/config.staging.json`:

- Set `aaveReceiverAddress` to your deployed AaveReceiver address.
- Set `inputConfig.walletAddress` to the wallet that holds tokens and approved AaveReceiver.
- Set `inputConfig.operation`, `asset`, `amount`, and any optional fields.

From the workflow directory:

```bash
cd cre-templates/starter-templates/aave-lending/aave-lending-ts/workflow
bun install   # or npm install
cre workflow simulate workflow --target staging-settings --trigger-index 1 --non-interactive --http-payload '{}'
```

`--trigger-index 1` uses the HTTP trigger (one-off). For a scheduled run use the cron trigger (index 0).

**Note:** `cre workflow simulate` runs in simulation mode. To submit the report on-chain you need a CRE environment that broadcasts (e.g. registered workflow and DON). See [CRE docs](https://docs.chain.link/cre).

---

## Pool Addresses (reference)

| Chain | Pool Address |
| ----- | ------------ |
| Arbitrum One | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Arbitrum Sepolia | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` |

---

## Troubleshooting

- **`AaveReceiver: supply transferFrom failed`**  
  The wallet does not hold enough of the underlying or has not approved AaveReceiver. Fix: fund the wallet and approve AaveReceiver for the asset.

- **`AaveReceiver: withdraw transferFrom failed`**  
  The wallet does not hold enough aTokens or has not approved AaveReceiver for the aToken. Fix: supply first to receive aTokens, then approve AaveReceiver for the aToken.

- **`AaveReceiver: repay transferFrom failed`**  
  Same as supply: fund the wallet with the borrowed asset and approve AaveReceiver.

- **`ENABLE_COLLATERAL and DISABLE_COLLATERAL must be called directly by the user`**  
  These operations use `msg.sender` as the user. Call `Pool.setUserUseReserveAsCollateral(asset, useAsCollateral)` from the user's wallet directly.

---

## Structure

- `aave-lending-ts/`: TypeScript workflow
  - `workflow/`: main.ts, workflow.yaml, config.staging.json, config.production.json, package.json
  - `contracts/abi/`: IERC20, IPool
- `contracts/src/`: AaveReceiver.sol and keystone interfaces (IReceiver, IERC165)

---

## Compatibility

Config is compatible for FlowForge workflows that can be invoked from the app with the same config (aligned with agentic LendingNodeConfig).

---

## License

MIT — see the repository [LICENSE](../../LICENSE).
