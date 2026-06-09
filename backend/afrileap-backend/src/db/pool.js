// src/db/pool.js
// ─────────────────────────────────────────────────────────────────
// PostgreSQL connection pool using the 'pg' library.
//
// WHY A POOL (not a single connection)?
//   Every HTTP request needs a DB connection. If you open a new
//   connection per request:
//     • Each connection takes ~50ms to establish (handshake + auth)
//     • Under load (100 req/s) you'd open 100 connections → server OOM
//   A pool maintains N persistent connections and hands them out.
//   Requests that arrive when the pool is full are queued automatically.
//
// POOL SIZING RULE OF THUMB:
//   pool_size = (number_of_cpu_cores × 2) + effective_spindle_count
//   For a typical cloud DB instance: 10 is a safe default.
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const { Pool } = require('pg');
const logger   = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              10,    // max connections in the pool
  idleTimeoutMillis: 30000, // close idle connections after 30s
  connectionTimeoutMillis: 5000, // throw if no connection available in 5s
  // In production with SSL (e.g. Supabase, Railway):
  // ssl: { rejectUnauthorized: false }
});

// Log pool-level errors (e.g. DB server restart, network drop)
pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { message: err.message });
});

// ─── QUERY HELPER ─────────────────────────────────────────────
// Wraps pool.query() to add automatic logging and error context.
// Use this everywhere instead of calling pool.query() directly.
//
// Usage:
//   const rows = await query('SELECT * FROM applications WHERE id = $1', [id]);
//
// PARAMETERISED QUERIES ($1, $2, ...) are critical for SQL injection
// prevention. Never string-interpolate user input into SQL.
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const duration = Date.now() - start;

    // Only log slow queries in production (> 200ms)
    if (process.env.NODE_ENV === 'production' && duration > 200) {
      logger.warn('Slow query detected', { duration, sql: sql.slice(0, 80) });
    } else if (process.env.NODE_ENV !== 'production') {
      logger.debug('DB query', { duration: `${duration}ms`, rows: result.rowCount });
    }

    return result.rows; // return rows array directly — cleaner call sites
  } catch (err) {
    logger.error('DB query failed', { message: err.message, sql: sql.slice(0, 80) });
    throw err; // re-throw so the caller can handle it
  }
}

// ─── TRANSACTION HELPER ───────────────────────────────────────
// Runs multiple queries in a single atomic DB transaction.
// If any query throws, ALL changes are rolled back automatically.
//
// Usage:
//   await withTransaction(async (client) => {
//     await client.query('INSERT INTO applications ...', [...]);
//     await client.query('UPDATE counters ...', [...]);
//   });
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('DB transaction rolled back', { message: err.message });
    throw err;
  } finally {
    client.release(); // ALWAYS release back to pool, even on error
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────
// Used by the /health endpoint to verify DB connectivity.
async function checkConnection() {
  const rows = await query('SELECT NOW() AS now');
  return rows[0].now;
}

module.exports = { query, withTransaction, checkConnection, pool };
