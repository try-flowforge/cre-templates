# Ostium Trading Starter Template

This Starter Template demonstrates how to integrate a Chainlink CRE workflow with the `flowforge-ostium-service` to automate perpetuals trading (such as opening a position) on the Ostium decentralized exchange.

The template uses the Chainlink CRE `HTTPClient` to send a securely authenticated (HMAC-SHA256) request to the internal Ostium backend service. The execution relies on BFT (Byzantine Fault Tolerant) capabilities to ensure trustless execution of the trade trigger.

## Directory Structure

```
ostium-trading/
├── project.yaml              # CRE project config (RPC environments)
├── secrets.yaml               # Secret ID → env var mapping for simulation
├── tsconfig.json              # TypeScript configuration
├── .env                       # Environment variables (HMAC secret, etc.)
└── workflow/
    ├── main.ts                # CRE entry point (payload, HMAC signing, HTTP POST)
    ├── workflow.yaml          # Workflow entrypoint configuration
    ├── config.staging.json    # Trade parameters for staging
    └── package.json           # Dependencies (@chainlink/cre-sdk, @noble/hashes, zod)
```

## Getting Started

### 1. Configure the Workflow

Update `workflow/config.staging.json` with your desired trade configuration:

```json
{
    "schedule": "0 */5 * * * *",
    "network": "testnet",
    "market": "ETH",
    "side": "long",
    "collateral": 100,
    "leverage": 10,
    "traderAddress": "0xYOUR_DELEGATED_SAFE_ADDRESS",
    "serviceUrl": "https://your-ostium-service.example.com",
    "slPrice": 1500,
    "tpPrice": 2500
}
```

### 2. Configure Secrets

The HMAC secret is **not** stored in the config file. It is fetched securely at runtime via `runtime.getSecret()`.

1.  Set your HMAC secret in `.env`:
    ```env
    OSTIUM_HMAC_SECRET_ALL=your_secure_hmac_secret_here
    ```
2.  The mapping is defined in `secrets.yaml`:
    ```yaml
    secretsNames:
      OSTIUM_HMAC_SECRET:
        - OSTIUM_HMAC_SECRET_ALL
    ```

### 3. Prepare Trading Prerequisites

Before executing a workflow that opens a position, you must ensure:
1. You have a deployed Safe wallet on the target network.
2. The Safe wallet has delegated permissions to the `flowforge-ostium-service` relayer.
3. The Safe wallet has sufficient USDC balance and has approved the Ostium Trading contracts.

### 4. Build and Simulate the CRE Workflow

Because the Chainlink CRE SDK relies heavily on the Bun runtime and requires specific compilation environments (like compiling without standard Node modules such as `node:crypto`), ensure you use `bun` for package management and CLI execution.

```bash
cd workflow
bun install
cd ..
bunx cre workflow simulate ./workflow -T staging
```

### 5. Dynamic Configuration (Optional)

You can override the static configuration defined in `config.*.json` dynamically by sending a JSON payload when triggering the workflow via HTTP. 

For example, to dynamically change from a Long to a Short position with higher collateral:

```json
{
  "side": "short",
  "collateral": 500,
  "leverage": 5
}
```

The workflow script uses `decodeJson(payload.input)` to map these arguments dynamically prior to securely computing the HMAC hash and executing the request.

---

## Detailed System Architecture

### 1. System Components

The architecture bridges the trustless Chainlink DON with the delegated Ostium transaction execution environment:

1. **Off-Chain Environment (Chainlink DON — `main.ts`)**
   - **Trigger:** Initiates the workflow (via Cron schedule or dynamic HTTP payload).
   - **Data Processing:** Formulates the trading payload. Because standard `node:crypto` is incompatible with the CRE WASM/QuickJS environment, it uses `@noble/hashes` to generate an HMAC-SHA256 signature.
   - **Secret Management:** The HMAC signing secret is fetched at runtime via `runtime.getSecret({ id: 'OSTIUM_HMAC_SECRET' })`, keeping it out of on-chain config.
   - **HTTP Capability:** Fires a synchronous `POST` request to `/v1/positions/open` on the target `flowforge-ostium-service`.

2. **Integration Backend (`flowforge-ostium-service`)**
   - **Authentication:** Validates the `x-signature` and `x-timestamp` against the shared secret to guarantee the request originated strictly from the Chainlink CRE.
   - **Trade Execution:** Translates the intent into a raw Ethereum transaction leveraging the user's previously delegated Safe wallet, interacting directly with Ostium's smart contracts.

### 2. Key Design Decisions

#### A. Cryptographic Compatibility
Since CRE's runtime compiles TypeScript into WebAssembly using QuickJS—which deliberately lacks the full `Node.js` API surface for security sandbox reasons—built-in crypto libraries are broken. The template avoids runtime crashes by exclusively utilizing `@noble/hashes` (specifically `hmac` and `sha256`) as a lightweight, WASM-safe fallback capable of satisfying the backend authentication requirements.

#### B. Dynamic Parameterization
The `main.ts` script allows partial overrides of the config schema. This enables dynamic adjustments—such as receiving an algorithmic trading signal via HTTP that dynamically dictates whether to long or short—without needing to re-compile or re-deploy the CRE workflow binary.
