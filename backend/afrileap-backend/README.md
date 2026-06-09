# AfriLeap Backend — Step 2: Node.js API + On-Chain Verification

## What this does

This is the backend API for the AfriLeap grant program. Its primary job
is to **independently verify that a Solana USDC transaction actually happened**
before accepting a grant application. The frontend cannot fake this.

```
POST /api/applications          ← submit application + tx proof
GET  /api/applications/:wallet  ← check application status
GET  /health                    ← server + DB + RPC health check
```

---

## Prerequisites

| Tool        | Version  | Install                              |
|-------------|----------|--------------------------------------|
| Node.js     | >= 18    | https://nodejs.org                   |
| PostgreSQL  | >= 14    | https://postgresql.org               |
| Solana CLI  | latest   | https://docs.solana.com/cli/install  |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Then edit `.env` and fill in:

- `DATABASE_URL` — your PostgreSQL connection string
- `TREASURY_WALLET_ADDRESS` — your Solana devnet wallet (see below)
- `JWT_SECRET` — a long random string

### 3. Create a treasury wallet (if you don't have one)

```bash
# Generate a new keypair
solana-keygen new --outfile treasury-keypair.json

# Get the address
solana address -k treasury-keypair.json

# Switch to devnet
solana config set --url devnet

# Airdrop some SOL for transaction fees
solana airdrop 2 -k treasury-keypair.json

# Create a USDC token account for the treasury
spl-token create-account Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr \
  --owner treasury-keypair.json
```

Paste the output address into `TREASURY_WALLET_ADDRESS` in `.env`.

### 4. Create the PostgreSQL database

```bash
createdb afrileap
```

### 5. Run the migration (creates all tables)

```bash
npm run migrate
```

You should see:
```
✅ Migration complete — all tables created.
```

### 6. Start the server

```bash
npm run dev       # development (auto-restarts on file change)
npm start         # production
```

Server starts on `http://localhost:3001`.

---

## Test the API

### Health check
```bash
curl http://localhost:3001/health
```

### Submit a test application
```bash
curl -X POST http://localhost:3001/api/applications \
  -H "Content-Type: application/json" \
  -d '{
    "firstName":               "Amara",
    "lastName":                "Osei",
    "email":                   "amara@test.com",
    "country":                 "Nigeria",
    "age":                     22,
    "institution":             "University of Lagos",
    "course":                  "Software Engineering / Web Dev",
    "walletAddress":           "YOUR_WALLET_ADDRESS",
    "verificationTxSignature": "YOUR_REAL_DEVNET_TX_SIGNATURE",
    "verificationTxCluster":   "devnet"
  }'
```

### Check application status
```bash
curl http://localhost:3001/api/applications/YOUR_WALLET_ADDRESS
```

---

## Run tests

```bash
npm test                  # run all tests
npm test -- --coverage    # with coverage report
npm test -- --watch       # re-run on file change
```

---

## How verification works (the security core)

When `POST /api/applications` is called, the server:

1. **Validates input** — every field is checked for type, length, format
2. **Checks for duplicates** — wallet, email, and tx signature must all be unique
3. **Calls Solana RPC** — `getParsedTransaction(signature)` fetches the real tx
4. **Verifies 9 properties** on the tx:
   - Signature is valid base58
   - Transaction exists on-chain
   - Transaction succeeded (no error)
   - Not too old (< 5 minutes)
   - Contains an SPL token transfer
   - Token mint is USDC (not a fake token)
   - Amount is exactly $1 (1,000,000 micro-USDC)
   - Recipient is the treasury's Associated Token Account
   - Authority (signer) matches the applicant's wallet address
5. **Logs the attempt** to `tx_audit_log` (even on failure)
6. **Inserts the application** to PostgreSQL with `tx_verified = TRUE`

The frontend cannot bypass any of this. Even if someone finds a valid
transaction signature on the blockchain and submits it, the sender check
(step 9) will reject it unless they also own that wallet.

---

## File structure

```
src/
  index.js                    ← Express app + startup
  routes/
    applications.js           ← HTTP route handlers
    health.js                 ← Health check endpoint
  services/
    solanaVerifier.js         ← ON-CHAIN TX VERIFICATION (core security)
    applicationService.js     ← Business logic (submit, status, list)
  middleware/
    validate.js               ← Input validation rules
  db/
    pool.js                   ← PostgreSQL connection pool + query helper
    migrate.js                ← Schema migration script
  utils/
    logger.js                 ← Winston structured logger

tests/
  solanaVerifier.test.js      ← Unit tests for the verifier
  applications.route.test.js  ← Integration tests for the API
```

---

## Coming in Step 3

- **World ID integration** — ZK proof of unique human identity
- **IPFS document storage** — student ID upload with on-chain CID
- **Admin dashboard** — approve/reject applications
- **Disbursal smart contract** — Anchor program that sends the $200 grant
