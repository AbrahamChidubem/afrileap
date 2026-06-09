// src/routes/applications.js
// ─────────────────────────────────────────────────────────────────
// HTTP ROUTE HANDLERS for /api/applications
//
// ROUTE HANDLER RESPONSIBILITY:
//   A route handler does ONLY these three things:
//     1. Parse / extract from req (body, params, query, headers)
//     2. Call the service layer
//     3. Format and send the HTTP response
//
//   It does NOT contain business logic. That lives in the service.
//   This separation makes both layers easier to test and reason about.
//
// ROUTES:
//   POST   /api/applications          → submit a new application
//   GET    /api/applications/:wallet  → check status by wallet address
//   GET    /api/applications          → admin: list all (requires auth)
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const {
  submitApplication,
  getApplicationStatus,
  listApplications
} = require('../services/applicationService');
const {
  applicationValidators,
  statusCheckValidators,
  listValidators,
  handleValidationErrors
} = require('../middleware/validate');
const logger = require('../utils/logger');

// ─── POST /api/applications ────────────────────────────────────
// Submit a new grant application.
// The validation chain runs first. If all checks pass,
// handleValidationErrors calls next() and we reach the handler.
router.post(
  '/',
  applicationValidators,      // field-by-field validators
  handleValidationErrors,     // reject if any validator failed
  async (req, res) => {
    try {
      // Extract IP (works behind proxies like nginx, Cloudflare)
      // In production, set `app.set('trust proxy', 1)` if behind a proxy
      const ipAddress = req.ip || req.socket.remoteAddress;

      const result = await submitApplication(req.body, ipAddress);

      if (result.success) {
        // 201 Created — the application was created
        return res.status(201).json({
          success:       true,
          applicationId: result.applicationId,
          message:       result.message,
          txDetails:     result.txDetails
        });
      }

      // Application rejected — determine HTTP status code by error type
      const statusCode = mapErrorToStatus(result.code);
      return res.status(statusCode).json({
        success: false,
        code:    result.code,
        error:   result.error
      });

    } catch (err) {
      logger.error('Unhandled error in POST /applications', {
        message: err.message,
        stack:   err.stack
      });
      // 500 Internal Server Error — something unexpected happened
      // DO NOT expose err.message to the client in production
      return res.status(500).json({
        success: false,
        error:   process.env.NODE_ENV === 'production'
          ? 'An internal error occurred. Please try again later.'
          : err.message
      });
    }
  }
);

// ─── GET /api/applications/:walletAddress ──────────────────────
// Public status check. Any applicant can check their status
// by providing their wallet address. No authentication required,
// but rate limiting applies (set in index.js).
router.get(
  '/:walletAddress',
  statusCheckValidators,
  handleValidationErrors,
  async (req, res) => {
    try {
      const status = await getApplicationStatus(req.params.walletAddress);

      if (!status) {
        return res.status(404).json({
          success: false,
          error:   'No application found for this wallet address'
        });
      }

      return res.status(200).json({ success: true, application: status });

    } catch (err) {
      logger.error('Error in GET /applications/:wallet', { message: err.message });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// ─── GET /api/applications (admin) ────────────────────────────
// Admin list endpoint — returns paginated applications.
// In Step 2b we'll add auth middleware here.
// For now it returns results (add auth before going to production).
router.get(
  '/',
  listValidators,
  handleValidationErrors,
  async (req, res) => {
    try {
      // TODO: Add authentication middleware before this goes to production
      // See: src/middleware/auth.js (Step 3)
      const { status, page, limit } = req.query;
      const result = await listApplications({ status, page, limit });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      logger.error('Error in GET /applications (admin list)', { message: err.message });
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// ─── ERROR CODE → HTTP STATUS MAP ─────────────────────────────
// Maps application-level error codes to appropriate HTTP status codes.
// 409 Conflict = "request conflicts with existing state" (duplicate)
// 400 Bad Request = "your input is wrong" (invalid tx, wrong amount)
// 422 Unprocessable = "valid format but business rule violated"
function mapErrorToStatus(code) {
  const map = {
    DUPLICATE_WALLET:  409,
    DUPLICATE_EMAIL:   409,
    DUPLICATE_TX:      409,
    REPLAY_ATTEMPT:    409,
    INVALID_FORMAT:    400,
    TX_NOT_FOUND:      422,
    TX_FAILED:         422,
    WRONG_TOKEN:       422,
    WRONG_AMOUNT:      422,
    WRONG_RECIPIENT:   422,
    WRONG_SENDER:      422,
    TX_TOO_OLD:        422,
    RPC_ERROR:         503, // Solana RPC unavailable — not the user's fault
  };
  return map[code] || 400;
}

module.exports = router;
