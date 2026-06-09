// src/middleware/validate.js
// ─────────────────────────────────────────────────────────────────
// REQUEST VALIDATION MIDDLEWARE
//
// WHY VALIDATE AT THE MIDDLEWARE LAYER?
//   • Your service/DB code assumes clean, typed data. If someone sends
//     age: "hello" or walletAddress: "<script>alert(1)</script>", your
//     SQL queries and Solana calls will behave unpredictably.
//   • Validation at the edge (before business logic) means:
//     → Bad requests are rejected fast (no DB/RPC cost)
//     → Service layer can trust its inputs
//     → Error messages are consistent and informative
//
// express-validator uses a declarative chain API:
//   body('field').trim().notEmpty().isLength({ max: 100 })
//   Each call adds a check. validationResult() collects all failures.
// ─────────────────────────────────────────────────────────────────

const { body, param, query, validationResult } = require('express-validator');

// ─── VALIDATION RULES ─────────────────────────────────────────

// Solana wallet address: base58, 32-44 characters
// (short addresses exist for program-owned accounts)
const solanaAddress = (field) =>
  body(field)
    .trim()
    .notEmpty().withMessage(`${field} is required`)
    .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .withMessage(`${field} must be a valid Solana address (base58, 32-44 chars)`);

// Solana tx signature: base58, 86-90 characters
const solanaTxSig = (field) =>
  body(field)
    .trim()
    .notEmpty().withMessage(`${field} is required`)
    .matches(/^[1-9A-HJ-NP-Za-km-z]{86,90}$/)
    .withMessage(`${field} must be a valid Solana transaction signature`);

// ─── APPLICATION SUBMIT VALIDATORS ────────────────────────────
const applicationValidators = [
  body('firstName')
    .trim()
    .notEmpty().withMessage('First name is required')
    .isLength({ min: 2, max: 100 }).withMessage('First name must be 2–100 characters')
    .matches(/^[\p{L}\s\-'\.]+$/u).withMessage('First name contains invalid characters'),

  body('lastName')
    .trim()
    .notEmpty().withMessage('Last name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Last name must be 2–100 characters')
    .matches(/^[\p{L}\s\-'\.]+$/u).withMessage('Last name contains invalid characters'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail() // lowercases, removes subaddress tricks like foo+bar@
    .isLength({ max: 255 }).withMessage('Email too long'),

  body('country')
    .trim()
    .notEmpty().withMessage('Country is required')
    .isLength({ min: 2, max: 100 }).withMessage('Country name must be 2–100 characters'),

  body('age')
    .notEmpty().withMessage('Age is required')
    .isInt({ min: 16, max: 30 }).withMessage('Age must be between 16 and 30')
    .toInt(), // convert string "22" to integer 22

  body('institution')
    .trim()
    .notEmpty().withMessage('Institution name is required')
    .isLength({ min: 2, max: 255 }).withMessage('Institution name must be 2–255 characters'),

  body('course')
    .trim()
    .notEmpty().withMessage('Course/field is required')
    .isLength({ min: 2, max: 100 }).withMessage('Course name must be 2–100 characters'),

  solanaAddress('walletAddress'),

  solanaTxSig('verificationTxSignature'),

  body('verificationTxCluster')
    .optional()
    .isIn(['devnet', 'mainnet-beta', 'testnet'])
    .withMessage('Cluster must be devnet, mainnet-beta, or testnet'),
];

// ─── STATUS CHECK VALIDATORS ───────────────────────────────────
const statusCheckValidators = [
  param('walletAddress')
    .trim()
    .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .withMessage('Invalid Solana wallet address'),
];

// ─── ADMIN LIST VALIDATORS ─────────────────────────────────────
const listValidators = [
  query('status')
    .optional()
    .isIn(['pending', 'under_review', 'approved', 'rejected'])
    .withMessage('Status must be pending, under_review, approved, or rejected'),

  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100')
    .toInt(),
];

// ─── RESULT HANDLER ────────────────────────────────────────────
// Run this AFTER the validators in the route handler array.
// If any validation failed, it sends a 400 with all error details.
// Otherwise it calls next() to proceed to the route handler.
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error:   'Validation failed',
      fields:  errors.array().map(e => ({
        field:   e.path,
        message: e.msg,
        value:   e.value  // echo back what we received (helps debug)
      }))
    });
  }
  next();
}

module.exports = {
  applicationValidators,
  statusCheckValidators,
  listValidators,
  handleValidationErrors,
};
