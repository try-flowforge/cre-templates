# LI.FI Swap Receiver Contract

This repository contains the `LifiReceiver` Solidity smart contract. This contract serves as the on-chain execution target for the Chainlink Custom Runtime Environment (CRE) workflow when performing LI.FI swaps.

It securely pulls ERC-20 tokens from a user, delegates allowance to the off-chain-determined LI.FI Diamond Router, and executes a low-level call containing the complex routing payload.

---

## Prerequisites

1. **Foundry:** This project is built using the Foundry framework. If you don't have it installed, run:
   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```
2. **Dependencies:** Install the standard library dependencies (if any are missing):
   ```bash
   forge install
   ```

---

## Configuration

1. Create a `.env` file in this `contracts/` directory.
2. Add your deployment private key and your preferred RPC URLs.
   ```env
   # .env
   PRIVATE_KEY=0xYourPrivateKeyHere
   RPC_URL=https://arb1.arbitrum.io/rpc
   ```
3. *(Optional for Verification)* If you wish to verify the contract on an explorer (like Arbiscan), add your API key:
   ```env
   ARBISCAN_API_KEY=YourArbiscanApiKeyHere
   ```

---

## Build & Test

To install dependencies and compile the smart contract and ensure there are no syntax or logic errors:
```bash
forge install
forge build
```

*(Note: If you add test files later, you can run them via `forge test`)*

---

## Deployment

We have provided a deployment script located at `scripts/DeployLifiReceiver.s.sol` to seamlessly deploy the contract to your target chain.

To deploy the contract (e.g., to Arbitrum Mainnet), run:

```bash
source .env
forge script scripts/DeployLifiReceiver.s.sol --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
```

Look at the console output to find your newly deployed contract address:
```
== Logs ==
  LifiReceiver deployed to: 0xYourNewContractAddress
```

---

## Contract Verification

If you want your contract source code to be readable and verifiable on Block Explorers, you can verify it either during deployment or after deployment.

**Option A: Verify during deployment**
Simply append the `--verify` flag your Forge script command:
```bash
source .env
forge script scripts/DeployLifiReceiver.s.sol --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast --verify --etherscan-api-key $ARBISCAN_API_KEY
```

**Option B: Verify after deployment**
If your contract is already deployed, use the `forge verify-contract` command:
```bash
source .env
forge verify-contract <DEPLOYED_CONTRACT_ADDRESS> src/LifiReceiver.sol:LifiReceiver --watch --etherscan-api-key $ARBISCAN_API_KEY --rpc-url $RPC_URL
```

---

## Post-Deployment Setup

Once the `LifiReceiver` is deployed, **it cannot pull your tokens until you explicitly grant it permission via an ERC-20 Approval.**

Before testing your Chainlink CRE workflow, ensure you approve your target ERC-20 token (e.g., USDC) to be spent by your new `LifiReceiver` address. 

You can do this easily using `cast`:
```bash
# Approves the LifiReceiver to spend an infinite amount of USDC
cast send <USDC_TOKEN_ADDRESS> "approve(address,uint256)" <DEPLOYED_LIFI_RECEIVER_ADDRESS> 115792089237316195423570985008687907853269984665640564039457584007913129639935 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```
