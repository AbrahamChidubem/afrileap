// src/services/solanaVerifier.js
// ─────────────────────────────────────────────────────────────────
// THE MOST IMPORTANT FILE IN THE BACKEND.
//
// This service independently verifies a Solana transaction that the
// frontend claims to have sent. It talks directly to the Solana RPC
// and checks every security property of the transaction.
//
// WHY INDEPENDENT VERIFICATION MATTERS:
//   The frontend is UNTRUSTED. A malicious user could:
//     (a) Paste any old tx signature they found on the explorer
//     (b) Send $0.001 USDC instead of $1.00
//     (c) Send to a different wallet than the treasury
//     (d) Replay a legitimate tx signature from another application
//     (e) Craft a fake tx signature string (not valid on-chain)
//   Without backend verification, any of these tricks would work.
//   With this service, all of them fail.
//
// THE VERIFICATION CHECKLIST (in order):
//   [1] Signature format — is this a valid base58 string?
//   [2] Transaction exists — does it exist on-chain at all?
//   [3] Transaction succeeded — did it execute without error?
//   [4] Correct token — was it USDC, not some random SPL token?
//   [5] Correct amount — exactly $1 (1,000,000 micro-USDC)?
//   [6] Correct recipient — did the money go to our treasury?
//   [7] Correct sender — does the sender match the applicant's wallet?
//   [8] Not too old — was the tx sent within the last 5 minutes?
//   [9] Not replayed — has this exact tx been used before?
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

// ─── CONFIGURATION ────────────────────────────────────────────
const SOLANA_RPC_URL   = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const TREASURY_WALLET  = process.env.TREASURY_WALLET_ADDRESS;
const USDC_MINT        = process.env.USDC_MINT_ADDRESS;
const USDC_AMOUNT      = parseInt(process.env.USDC_VERIFICATION_AMOUNT || '1000000');
const TX_MAX_AGE_SEC   = parseInt(process.env.TX_MAX_AGE_SECONDS || '300');

// Create a persistent connection (reused across requests — don't create one per request)
const connection = new Connection(SOLANA_RPC_URL, {
  commitment: 'confirmed', // wait for 2/3 of validators to confirm
  // 'finalized' is more secure but slower (~32 slots / ~13s extra wait)
  // 'confirmed' is the right tradeoff for a $1 verification payment
});

// ─── RESULT CODES ─────────────────────────────────────────────
// Consistent result codes across the app. These go into tx_audit_log.
const RESULT = {
  VALID:            'valid',
  INVALID_FORMAT:   'invalid_format',
  TX_NOT_FOUND:     'tx_not_found',
  TX_FAILED:        'tx_failed',
  WRONG_TOKEN:      'wrong_token',
  WRONG_AMOUNT:     'wrong_amount',
  WRONG_RECIPIENT:  'wrong_recipient',
  WRONG_SENDER:     'wrong_sender',
  TX_TOO_OLD:       'tx_too_old',
  REPLAY_ATTEMPT:   'replay_attempt',
  RPC_ERROR:        'rpc_error',
};

// ─── MAIN VERIFIER ────────────────────────────────────────────
/**
 * Verifies a Solana USDC transfer transaction.
 *
 * @param {string} txSignature    - The base58 tx signature from the frontend
 * @param {string} claimedSender  - The wallet address the applicant claims to own
 * @param {Set}    usedSignatures - Set of already-used tx signatures (from DB cache)
 * @returns {{ valid: boolean, code: string, details: object }}
 */
async function verifyTransaction(txSignature, claimedSender, usedSignatures) {
  logger.info('Starting tx verification', { txSignature, claimedSender });

  // ── CHECK [1]: Signature format ──────────────────────────────
  // A Solana tx signature is 64 bytes encoded as base58 → 87-88 chars.
  // We validate format before touching the RPC to save a network call.
  if (!isValidBase58Signature(txSignature)) {
    logger.warn('Invalid tx signature format', { txSignature });
    return fail(RESULT.INVALID_FORMAT, 'Transaction signature is not valid base58');
  }

  // ── CHECK [9] (early): Replay attempt ────────────────────────
  // Check this BEFORE the RPC call — if we've seen this sig before,
  // we don't need to waste an RPC call confirming it again.
  if (usedSignatures && usedSignatures.has(txSignature)) {
    logger.warn('Replay attempt detected', { txSignature, claimedSender });
    return fail(RESULT.REPLAY_ATTEMPT, 'This transaction has already been used for a previous application');
  }

  // ── CHECK [2] + [3]: Transaction exists and succeeded ────────
  let parsedTx;
  try {
    // getParsedTransaction returns the FULL decoded transaction.
    // 'jsonParsed' encoding makes SPL token instructions human-readable.
    // maxSupportedTransactionVersion: 0 handles legacy + v0 tx formats.
    parsedTx = await connection.getParsedTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    logger.error('RPC call failed during tx lookup', { message: err.message, txSignature });
    return fail(RESULT.RPC_ERROR, 'Solana RPC error: ' + err.message);
  }

  // If null, the tx doesn't exist on this cluster
  if (!parsedTx) {
    logger.warn('Transaction not found on-chain', { txSignature });
    return fail(RESULT.TX_NOT_FOUND, 'Transaction not found on the Solana network');
  }

  // meta.err is null if the transaction succeeded, or an object if it failed
  if (parsedTx.meta?.err !== null) {
    logger.warn('Transaction failed on-chain', { txSignature, err: parsedTx.meta.err });
    return fail(RESULT.TX_FAILED, 'The transaction failed on-chain and did not execute');
  }

  // ── CHECK [8]: Transaction age ────────────────────────────────
  // blockTime is a Unix timestamp (seconds) set by the validator.
  // We reject transactions older than TX_MAX_AGE_SEC to prevent
  // someone reusing a tx from days/weeks ago.
  const nowSec        = Math.floor(Date.now() / 1000);
  const txAgeSeconds  = nowSec - parsedTx.blockTime;

  if (txAgeSeconds > TX_MAX_AGE_SEC) {
    logger.warn('Transaction too old', { txSignature, txAgeSeconds, maxAge: TX_MAX_AGE_SEC });
    return fail(RESULT.TX_TOO_OLD,
      `Transaction is ${Math.round(txAgeSeconds / 60)} minutes old. ` +
      `Must be within ${TX_MAX_AGE_SEC / 60} minutes.`
    );
  }

  // ── EXTRACT SPL TOKEN TRANSFER INSTRUCTIONS ───────────────────
  // A transaction can contain multiple instructions. We need to find
  // the one that is a USDC SPL token transfer.
  //
  // With 'jsonParsed' encoding, Solana decodes known program instructions
  // into human-readable JSON. An SPL token transfer looks like:
  //
  //   {
  //     programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  //     parsed: {
  //       type: 'transfer' | 'transferChecked',
  //       info: {
  //         source:      'source ATA address',
  //         destination: 'destination ATA address',
  //         authority:   'wallet that signed',
  //         mint:        'USDC mint address',   (only on transferChecked)
  //         tokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 }
  //       }
  //     }
  //   }
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // Collect all instructions (including inner instructions from CPI calls)
  const allInstructions = [];

  // Top-level instructions
  for (const ix of (parsedTx.transaction.message.instructions || [])) {
    if (ix.programId === TOKEN_PROGRAM && ix.parsed) {
      allInstructions.push(ix);
    }
  }

  // Inner instructions (e.g. when a program CPI-calls the token program)
  for (const innerGroup of (parsedTx.meta?.innerInstructions || [])) {
    for (const ix of innerGroup.instructions) {
      if (ix.programId === TOKEN_PROGRAM && ix.parsed) {
        allInstructions.push(ix);
      }
    }
  }

  // Filter to transfer or transferChecked instructions
  const transferInstructions = allInstructions.filter(ix =>
    ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked'
  );

  if (transferInstructions.length === 0) {
    logger.warn('No SPL token transfer instruction found in tx', { txSignature });
    return fail(RESULT.WRONG_TOKEN, 'Transaction does not contain an SPL token transfer');
  }

  // ── FIND THE QUALIFYING TRANSFER ──────────────────────────────
  // There might be multiple transfers in one tx (e.g. a swap).
  // We look for the specific one that sends $1 USDC to the treasury.
  let qualifyingTransfer = null;

  // We also need the post-transaction token balances to verify the
  // mint (for plain 'transfer' instructions that don't include mint).
  // post_token_balances maps account index → { mint, owner, uiTokenAmount }
  const postBalancesByPubkey = {};
  for (const bal of (parsedTx.meta?.postTokenBalances || [])) {
    const accountKey = parsedTx.transaction.message.accountKeys[bal.accountIndex];
    if (accountKey) {
      postBalancesByPubkey[accountKey.pubkey] = bal;
    }
  }

  for (const ix of transferInstructions) {
    const info = ix.parsed.info;

    // ── CHECK [4]: Correct token (USDC mint) ──────────────────
    let mint = info.mint; // present on transferChecked

    if (!mint) {
      // For plain 'transfer', look up the destination ATA's mint
      // from post-token balances
      const destBalance = postBalancesByPubkey[info.destination];
      mint = destBalance?.mint;
    }

    if (mint !== USDC_MINT) {
      logger.debug('Transfer uses wrong mint — skipping', { mint, expected: USDC_MINT });
      continue; // not USDC, check next instruction
    }

    // ── CHECK [5]: Correct amount ($1 USDC = 1,000,000) ───────
    const amountStr = info.tokenAmount?.amount ?? info.amount;
    const amount    = parseInt(amountStr, 10);

    if (amount !== USDC_AMOUNT) {
      logger.debug('Transfer amount mismatch', { amount, expected: USDC_AMOUNT });
      continue; // wrong amount, check next instruction
    }

    // ── CHECK [6]: Correct recipient (treasury ATA) ────────────
    // The destination is the treasury's Associated Token Account, NOT
    // the treasury wallet address itself. We need to derive it.
    const treasuryATA = await deriveATA(new PublicKey(TREASURY_WALLET), new PublicKey(USDC_MINT));
    const destPubkey  = info.destination;

    if (destPubkey !== treasuryATA.toString()) {
      logger.debug('Transfer destination is not treasury ATA', {
        destination: destPubkey,
        expectedATA: treasuryATA.toString()
      });
      continue; // wrong recipient, check next instruction
    }

    // ── CHECK [7]: Correct sender ──────────────────────────────
    // 'authority' is the wallet key that signed the transfer (the owner
    // of the source ATA). This must match the claimedSender.
    const sender = info.authority;
    if (sender !== claimedSender) {
      logger.warn('Sender mismatch — possible account hijack attempt', {
        sender,
        claimedSender,
        txSignature
      });
      return fail(RESULT.WRONG_SENDER,
        'The transaction was signed by a different wallet than the application wallet'
      );
    }

    // All checks passed for this instruction
    qualifyingTransfer = { ix, sender, amount, mint };
    break;
  }

  if (!qualifyingTransfer) {
    // We found token transfers but none passed all checks.
    // Determine the most specific failure reason for the audit log.
    logger.warn('No qualifying USDC transfer found', { txSignature, claimedSender });
    return fail(RESULT.WRONG_AMOUNT,
      'Transaction does not contain a $1 USDC transfer to the AfriLeap treasury'
    );
  }

  // ── ALL CHECKS PASSED ─────────────────────────────────────────
  logger.info('✅ Transaction verified successfully', {
    txSignature,
    sender:  qualifyingTransfer.sender,
    amount:  qualifyingTransfer.amount,
    blockTime: parsedTx.blockTime,
    ageSeconds: txAgeSeconds
  });

  return {
    valid: true,
    code:  RESULT.VALID,
    details: {
      txSignature,
      sender:        qualifyingTransfer.sender,
      amountUSDC:    qualifyingTransfer.amount / 1_000_000,
      blockTime:     parsedTx.blockTime,
      slot:          parsedTx.slot,
      treasuryATA:   (await deriveATA(new PublicKey(TREASURY_WALLET), new PublicKey(USDC_MINT))).toString()
    }
  };
}

// ─── HELPER: Derive Associated Token Account ──────────────────
// An ATA is a Program Derived Address computed from:
//   seeds = [walletAddress, TOKEN_PROGRAM_ID, mintAddress]
//   program = ASSOCIATED_TOKEN_PROGRAM_ID
//
// This is the same derivation the frontend does. We recompute it
// here so we never trust the frontend to tell us the correct ATA.
async function deriveATA(walletPubkey, mintPubkey) {
  const { PublicKey: PK } = require('@solana/web3.js');
  const TOKEN_PROGRAM      = new PK('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ASSOC_TOKEN_PROG   = new PK('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS');

  const [ata] = PK.findProgramAddressSync(
    [
      walletPubkey.toBuffer(),
      TOKEN_PROGRAM.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    ASSOC_TOKEN_PROG
  );
  return ata;
}

// ─── HELPER: Validate base58 signature format ─────────────────
// A Solana tx signature is 64 bytes → base58 → 87 or 88 characters.
// Base58 uses: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
// (no 0, O, I, l to avoid visual confusion)
function isValidBase58Signature(sig) {
  if (typeof sig !== 'string') return false;
  if (sig.length < 86 || sig.length > 90) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(sig);
}

// ─── HELPER: Build a fail result ──────────────────────────────
function fail(code, message) {
  return { valid: false, code, details: { message } };
}

// ─── EXPORTS ──────────────────────────────────────────────────
module.exports = { verifyTransaction, RESULT, connection };
