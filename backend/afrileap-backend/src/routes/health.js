// src/routes/health.js
// ─────────────────────────────────────────────────────────────────
// HEALTH CHECK ENDPOINT: GET /health
//
// WHY A HEALTH CHECK?
//   Load balancers, container orchestrators (Docker, Kubernetes),
//   and uptime monitors all need a way to ask "is this server alive?"
//   A health check that verifies REAL dependencies (DB, RPC) is more
//   useful than one that just returns 200 OK regardless of state.
//
// RESPONSE DESIGN:
//   • 200 OK   → all systems healthy
//   • 503 Unavailable → one or more dependencies are down
//   Either way, we return JSON so a monitoring system can parse it.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { checkConnection } = require('../db/pool');
const { connection }      = require('../services/solanaVerifier');
const logger              = require('../utils/logger');

router.get('/', async (req, res) => {
  const checks = { db: false, solana: false };
  const errors  = [];
  const start   = Date.now();

  // ── Check PostgreSQL ──────────────────────────────────────────
  try {
    await checkConnection();
    checks.db = true;
  } catch (err) {
    errors.push('Database: ' + err.message);
    logger.error('Health check — DB failed', { message: err.message });
  }

  // ── Check Solana RPC ──────────────────────────────────────────
  try {
    // getSlot() is the lightest possible RPC call
    await connection.getSlot();
    checks.solana = true;
  } catch (err) {
    errors.push('Solana RPC: ' + err.message);
    logger.error('Health check — Solana RPC failed', { message: err.message });
  }

  const healthy    = checks.db && checks.solana;
  const statusCode = healthy ? 200 : 503;

  return res.status(statusCode).json({
    status:      healthy ? 'ok' : 'degraded',
    checks,
    errors:      errors.length ? errors : undefined,
    latency_ms:  Date.now() - start,
    timestamp:   new Date().toISOString(),
    cluster:     process.env.SOLANA_CLUSTER || 'devnet',
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;
