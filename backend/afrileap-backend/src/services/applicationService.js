// src/services/applicationService.js
// ─────────────────────────────────────────────────────────────────
// APPLICATION SERVICE — business logic layer
//
// WHY A SERVICE LAYER?
//   The route handler (HTTP layer) should only deal with:
//     → parse request, call service, format response, send it
//   All business logic lives here:
//     → what does "submit an application" actually mean?
//     → what order do things happen in?
//     → what are the failure modes?
//   This makes the code testable (test the service in isolation)
//   and maintainable (change business rules in one place).
//
// THE APPLICATION SUBMISSION FLOW:
//   1. Check for duplicate wallet / email / tx signature (fast DB check)
//   2. Verify the tx on-chain (Solana RPC call — the slowest part)
//   3. Write audit log (always, even on failure — for fraud analysis)
//   4. If tx valid: insert application row in DB
//   5. Return result to route handler
// ─────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../db/pool');
const { verifyTransaction, RESULT } = require('./solanaVerifier');
const logger = require('../utils/logger');

// ─── IN-MEMORY CACHE OF USED TX SIGNATURES ────────────────────
// We keep a Set of already-used tx signatures in memory so we can
// reject replays BEFORE hitting the RPC (saves ~200ms per request).
//
// CAVEAT: this resets on server restart. The authoritative check is
// the UNIQUE constraint on tx_signature in the DB — this is just an
// optimisation. On startup we hydrate this set from the DB.
const usedTxSignatures = new Set();

async function hydrateUsedSignatures() {
  const rows = await query('SELECT tx_signature FROM applications');
  rows.forEach(r => usedTxSignatures.add(r.tx_signature));
  logger.info(`Loaded ${usedTxSignatures.size} known tx signatures into memory cache`);
}

// ─── SUBMIT APPLICATION ───────────────────────────────────────
/**
 * Full application submission flow.
 *
 * @param {object} data - Validated form data from the request body
 * @param {string} ipAddress - Requester's IP for audit logging
 * @returns {{ success: boolean, applicationId?: string, error?: string, code?: string }}
 */
async function submitApplication(data, ipAddress) {
  const {
    firstName, lastName, email, country, age,
    institution, course, walletAddress,
    verificationTxSignature, verificationTxCluster
  } = data;

  logger.info('Processing application submission', { walletAddress, email });

  // ── STEP 1: Duplicate checks (fast, before hitting RPC) ───────
  // Check wallet, email, AND tx signature. Each has a different
  // user-facing error message. We check all three in one query.
  const existingRows = await query(`
    SELECT
      wallet_address, email, tx_signature
    FROM applications
    WHERE
      wallet_address = $1
      OR email       = $2
      OR tx_signature = $3
    LIMIT 1
  `, [walletAddress, email, verificationTxSignature]);

  if (existingRows.length > 0) {
    const existing = existingRows[0];
    let code, message;

    if (existing.wallet_address === walletAddress) {
      code    = 'DUPLICATE_WALLET';
      message = 'A grant application already exists for this wallet address.';
    } else if (existing.email === email) {
      code    = 'DUPLICATE_EMAIL';
      message = 'A grant application already exists for this email address.';
    } else {
      code    = 'DUPLICATE_TX';
      message = 'This transaction signature has already been used for a previous application.';
    }

    logger.warn('Duplicate application rejected', { code, walletAddress, email });
    return { success: false, code, error: message };
  }

  // ── STEP 2: On-chain transaction verification ─────────────────
  // This is the most important step. See solanaVerifier.js for details.
  const verification = await verifyTransaction(
    verificationTxSignature,
    walletAddress,
    usedTxSignatures
  );

  // ── STEP 3: Write audit log (always — even on failure) ────────
  // We do this BEFORE the application insert so we have a record
  // even if the application insert fails.
  await query(`
    INSERT INTO tx_audit_log
      (wallet_address, tx_signature, verification_result, rpc_response, ip_address)
    VALUES ($1, $2, $3, $4, $5::inet)
  `, [
    walletAddress,
    verificationTxSignature,
    verification.code,
    JSON.stringify(verification.details),
    ipAddress
  ]).catch(err => {
    // Non-fatal: don't block the application if audit log fails
    logger.error('Failed to write audit log', { message: err.message });
  });

  if (!verification.valid) {
    logger.warn('Application rejected — tx verification failed', {
      code:   verification.code,
      wallet: walletAddress,
      detail: verification.details.message
    });
    return {
      success: false,
      code:    verification.code,
      error:   verification.details.message
    };
  }

  // ── STEP 4: Insert application ────────────────────────────────
  // We use withTransaction to ensure the application row and the
  // audit log update are atomic. If the application insert fails,
  // the audit log application_id stays NULL (not orphaned).
  let applicationId;
  try {
    await withTransaction(async (client) => {
      // Insert the application
      const rows = await client.query(`
        INSERT INTO applications (
          first_name, last_name, email, country, age,
          institution, course, wallet_address,
          tx_signature, tx_cluster, tx_verified, tx_verified_at,
          status
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, TRUE, NOW(),
          'pending'
        )
        RETURNING id
      `, [
        firstName, lastName, email, country, age,
        institution, course, walletAddress,
        verificationTxSignature, verificationTxCluster || 'devnet'
      ]);

      applicationId = rows.rows[0].id;

      // Update audit log row with the new application ID
      await client.query(`
        UPDATE tx_audit_log
        SET application_id = $1
        WHERE tx_signature = $2
          AND application_id IS NULL
      `, [applicationId, verificationTxSignature]);
    });

    // Add to in-memory cache so future duplicate checks are fast
    usedTxSignatures.add(verificationTxSignature);

    logger.info('✅ Application created successfully', {
      applicationId,
      walletAddress,
      email
    });

    return {
      success: true,
      applicationId,
      message: 'Application submitted and verified. Review takes 5–7 business days.',
      txDetails: {
        signature:  verificationTxSignature,
        explorerUrl: `https://explorer.solana.com/tx/${verificationTxSignature}` +
                     (verificationTxCluster === 'devnet' ? '?cluster=devnet' : '')
      }
    };

  } catch (err) {
    // The most likely cause: race condition where two requests from
    // the same wallet arrived simultaneously and both passed the
    // duplicate check. The DB UNIQUE constraint catches the second one.
    if (err.code === '23505') { // PostgreSQL unique violation code
      const constraint = err.constraint;
      logger.warn('DB unique constraint violation on application insert', { constraint });
      return {
        success: false,
        code:    'DUPLICATE_' + (constraint?.includes('wallet') ? 'WALLET' :
                                  constraint?.includes('email')  ? 'EMAIL'  : 'TX'),
        error:   'An application with this information already exists.'
      };
    }

    logger.error('Unexpected error inserting application', { message: err.message, stack: err.stack });
    throw err; // rethrow — route handler will catch and return 500
  }
}

// ─── GET APPLICATION STATUS ───────────────────────────────────
/**
 * Public status check — applicant can check their status by wallet.
 * Returns limited info (no reviewer notes, no internal IDs).
 */
async function getApplicationStatus(walletAddress) {
  const rows = await query(`
    SELECT
      id,
      status,
      created_at,
      reviewed_at,
      disbursed_at,
      tx_signature,
      tx_cluster
    FROM applications
    WHERE wallet_address = $1
  `, [walletAddress]);

  if (rows.length === 0) {
    return null;
  }

  const app = rows[0];
  return {
    applicationId: app.id,
    status:        app.status,
    submittedAt:   app.created_at,
    reviewedAt:    app.reviewed_at,
    disbursedAt:   app.disbursed_at,
    txExplorerUrl: `https://explorer.solana.com/tx/${app.tx_signature}` +
                   (app.tx_cluster === 'devnet' ? '?cluster=devnet' : '')
  };
}

// ─── ADMIN: LIST APPLICATIONS ─────────────────────────────────
/**
 * Admin endpoint — paginated list with optional status filter.
 */
async function listApplications({ status, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const params = [limit, offset];
  let whereClause = '';

  if (status) {
    params.push(status);
    whereClause = `WHERE status = $${params.length}`;
  }

  const rows = await query(`
    SELECT
      id, first_name, last_name, email, country,
      wallet_address, status, tx_verified,
      created_at, reviewed_at, disbursed_at
    FROM applications
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, params);

  const countRows = await query(`
    SELECT COUNT(*) AS total FROM applications ${whereClause}
  `, status ? [status] : []);

  return {
    applications: rows,
    total: parseInt(countRows[0].total),
    page,
    totalPages: Math.ceil(countRows[0].total / limit)
  };
}

module.exports = {
  submitApplication,
  getApplicationStatus,
  listApplications,
  hydrateUsedSignatures
};
