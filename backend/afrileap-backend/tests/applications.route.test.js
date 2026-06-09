// tests/applications.route.test.js
// ─────────────────────────────────────────────────────────────────
// INTEGRATION TESTS for POST /api/applications
//
// These tests use supertest to fire real HTTP requests at the Express
// app (without starting a server on a port). We mock the service layer
// so we're testing the HTTP layer: routing, validation, response format.
// ─────────────────────────────────────────────────────────────────

process.env.DATABASE_URL             = 'postgresql://test:test@localhost/test';
process.env.TREASURY_WALLET_ADDRESS  = 'TreasuryWallet1111111111111111111111111111';
process.env.USDC_MINT_ADDRESS        = 'USDCMint111111111111111111111111111111111111';
process.env.USDC_VERIFICATION_AMOUNT = '1000000';
process.env.TX_MAX_AGE_SECONDS       = '300';
process.env.SOLANA_RPC_URL           = 'https://api.devnet.solana.com';
process.env.LOG_LEVEL                = 'error';
process.env.CORS_ORIGINS             = 'http://localhost:3000';

// Mock heavy dependencies so tests run without a real DB or Solana node
jest.mock('../src/db/pool', () => ({
  query:           jest.fn(),
  withTransaction: jest.fn(),
  checkConnection: jest.fn().mockResolvedValue(new Date()),
  pool:            { end: jest.fn() }
}));

jest.mock('../src/services/applicationService', () => ({
  submitApplication:     jest.fn(),
  getApplicationStatus:  jest.fn(),
  listApplications:      jest.fn(),
  hydrateUsedSignatures: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@solana/web3.js', () => ({
  Connection:  jest.fn().mockImplementation(() => ({ getSlot: jest.fn().mockResolvedValue(1) })),
  PublicKey:   jest.fn().mockImplementation((v) => ({
    toString: () => v,
    toBuffer: () => Buffer.alloc(32)
  }))
}));

const request = require('supertest');
const app     = require('../src/index');
const { submitApplication, getApplicationStatus } = require('../src/services/applicationService');

// ─── VALID PAYLOAD ─────────────────────────────────────────────
const VALID_PAYLOAD = {
  firstName:                 'Amara',
  lastName:                  'Osei',
  email:                     'amara.osei@unilag.edu.ng',
  country:                   'Nigeria',
  age:                       22,
  institution:               'University of Lagos',
  course:                    'Software Engineering / Web Dev',
  walletAddress:             '7xKp4sL8mNjPqRtYvWzXcFbGhDkEiAoUyTsQwZr2nBv',
  verificationTxSignature:   '5hGK9zWmAtNbSbqVZaVMiXBcZ5rHxFp8kL3JnPqYdRtQeWuVs7mNjLfCgBpXzYwKhA2rDqMnPs4TxVcFbZeG1sM',
  verificationTxCluster:     'devnet'
};

// ─── TESTS ────────────────────────────────────────────────────

describe('POST /api/applications', () => {

  beforeEach(() => jest.clearAllMocks());

  // ── Success case ──────────────────────────────────────────
  test('201: creates application when all data is valid', async () => {
    submitApplication.mockResolvedValue({
      success:       true,
      applicationId: 'abc-123-uuid',
      message:       'Application submitted and verified.',
      txDetails:     { signature: VALID_PAYLOAD.verificationTxSignature, explorerUrl: 'https://...' }
    });

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.applicationId).toBe('abc-123-uuid');
    expect(submitApplication).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: VALID_PAYLOAD.walletAddress }),
      expect.any(String) // IP address
    );
  });

  // ── Validation errors ─────────────────────────────────────
  test('400: rejects request with missing required fields', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ firstName: 'Amara' }) // most fields missing
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.fields).toBeDefined();
    expect(res.body.fields.length).toBeGreaterThan(0);
    // Service should NOT be called if validation fails
    expect(submitApplication).not.toHaveBeenCalled();
  });

  test('400: rejects age outside 16–30 range', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...VALID_PAYLOAD, age: 15 }) // too young
      .expect(400);

    expect(res.body.fields.some(f => f.field === 'age')).toBe(true);
  });

  test('400: rejects invalid email format', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...VALID_PAYLOAD, email: 'not-an-email' })
      .expect(400);

    expect(res.body.fields.some(f => f.field === 'email')).toBe(true);
  });

  test('400: rejects invalid Solana wallet address (wrong chars)', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...VALID_PAYLOAD, walletAddress: 'not-a-valid-wallet-0OIl' })
      .expect(400);

    expect(res.body.fields.some(f => f.field === 'walletAddress')).toBe(true);
  });

  test('400: rejects short tx signature', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...VALID_PAYLOAD, verificationTxSignature: 'tooshort' })
      .expect(400);

    expect(res.body.fields.some(f => f.field === 'verificationTxSignature')).toBe(true);
  });

  // ── Conflict errors ───────────────────────────────────────
  test('409: returns conflict when wallet is already registered', async () => {
    submitApplication.mockResolvedValue({
      success: false,
      code:    'DUPLICATE_WALLET',
      error:   'A grant application already exists for this wallet address.'
    });

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('DUPLICATE_WALLET');
  });

  test('409: returns conflict when tx signature is replayed', async () => {
    submitApplication.mockResolvedValue({
      success: false,
      code:    'REPLAY_ATTEMPT',
      error:   'This transaction signature has already been used.'
    });

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(409);

    expect(res.body.code).toBe('REPLAY_ATTEMPT');
  });

  // ── Business rule errors ──────────────────────────────────
  test('422: returns error when tx amount is wrong', async () => {
    submitApplication.mockResolvedValue({
      success: false,
      code:    'WRONG_AMOUNT',
      error:   'Transaction does not contain a $1 USDC transfer.'
    });

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(422);

    expect(res.body.code).toBe('WRONG_AMOUNT');
  });

  test('503: returns service unavailable when RPC is down', async () => {
    submitApplication.mockResolvedValue({
      success: false,
      code:    'RPC_ERROR',
      error:   'Solana RPC error: Connection refused'
    });

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(503);

    expect(res.body.code).toBe('RPC_ERROR');
  });

  // ── Server error ──────────────────────────────────────────
  test('500: returns generic error on unexpected service crash', async () => {
    submitApplication.mockRejectedValue(new Error('Database went boom'));

    const res = await request(app)
      .post('/api/applications')
      .send(VALID_PAYLOAD)
      .expect(500);

    expect(res.body.success).toBe(false);
  });
});

// ─── STATUS CHECK ─────────────────────────────────────────────
describe('GET /api/applications/:walletAddress', () => {

  test('200: returns application status for known wallet', async () => {
    getApplicationStatus.mockResolvedValue({
      applicationId: 'abc-123',
      status:        'under_review',
      submittedAt:   new Date().toISOString()
    });

    const res = await request(app)
      .get(`/api/applications/${VALID_PAYLOAD.walletAddress}`)
      .expect(200);

    expect(res.body.application.status).toBe('under_review');
  });

  test('404: returns not found for unknown wallet', async () => {
    getApplicationStatus.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/applications/${VALID_PAYLOAD.walletAddress}`)
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  test('400: rejects invalid wallet address format', async () => {
    const res = await request(app)
      .get('/api/applications/not-valid-0OIl')
      .expect(400);

    expect(res.body.success).toBe(false);
  });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
describe('GET /health', () => {
  test('returns health status object', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('checks');
  });
});
