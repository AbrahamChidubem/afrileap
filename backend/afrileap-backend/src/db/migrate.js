// src/db/migrate.js
// ─────────────────────────────────────────────────────────────────
// Database schema migration — run once with: node src/db/migrate.js
//
// WHAT IS A MIGRATION?
//   A migration is a versioned script that evolves your database schema.
//   Instead of manually ALTER TABLEing in production (risky, untracked),
//   you write migrations that can be run forward (apply) or backward (undo).
//   This file is a simplified single-run migration. Production apps use
//   a migration tool like Flyway, Liquibase, or node-pg-migrate.
//
// DESIGN DECISIONS IN THIS SCHEMA:
//   • UUID primary keys: harder to enumerate than auto-increment integers
//     (an attacker can't guess /api/applications/1, /api/applications/2...)
//   • created_at / updated_at: always include these on every table —
//     invaluable for debugging, analytics, and auditing
//   • UNIQUE constraints: enforce business rules at the DB level, not just
//     application code. Even if your app has a bug, the DB won't allow
//     two applications from the same wallet or the same tx signature.
//   • tx_signature as UNIQUE: if an attacker somehow gets a valid tx
//     signature and tries to submit it multiple times from different
//     browser sessions, the DB rejects all duplicates
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const { pool } = require('./pool');
const logger   = require('../utils/logger');

async function migrate() {
  const client = await pool.connect();
  logger.info('Running database migration…');

  try {
    await client.query('BEGIN');

    // ── Enable UUID generation ─────────────────────────────────
    // PostgreSQL needs this extension to use gen_random_uuid()
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    // ── applications table ────────────────────────────────────
    // Central table. One row per student application.
    await client.query(`
      CREATE TABLE IF NOT EXISTS applications (

        -- Primary key: random UUID, not sequential integer
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- ── Personal info ──────────────────────────────────────
        first_name        VARCHAR(100) NOT NULL,
        last_name         VARCHAR(100) NOT NULL,
        email             VARCHAR(255) NOT NULL,
        country           VARCHAR(100) NOT NULL,
        age               SMALLINT     NOT NULL CHECK (age BETWEEN 16 AND 30),
        institution       VARCHAR(255) NOT NULL,
        course            VARCHAR(100) NOT NULL,

        -- ── Wallet & blockchain ────────────────────────────────
        -- wallet_address: Solana base58 address, 32-44 chars
        wallet_address    VARCHAR(44)  NOT NULL,

        -- tx_signature: the on-chain $1 USDC payment proof
        -- 87-88 chars in base58
        tx_signature      VARCHAR(90)  NOT NULL,

        -- Which Solana cluster the tx was sent on
        tx_cluster        VARCHAR(20)  NOT NULL DEFAULT 'devnet',

        -- Verified: set to TRUE only after our backend independently
        -- confirms the tx on-chain (see verifyTransaction service)
        tx_verified       BOOLEAN      NOT NULL DEFAULT FALSE,

        -- The UTC timestamp when we confirmed the tx on-chain
        tx_verified_at    TIMESTAMPTZ,

        -- ── Application status ─────────────────────────────────
        -- Lifecycle: pending → under_review → approved | rejected
        status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','under_review','approved','rejected')),

        -- Reviewer notes (internal, never shown to applicant)
        reviewer_notes    TEXT,

        -- Which admin approved or rejected (FK to admins table below)
        reviewed_by       UUID REFERENCES admins(id),

        reviewed_at       TIMESTAMPTZ,

        -- ── Disbursal ──────────────────────────────────────────
        -- The $200 grant payment tx signature (set after disbursal)
        disbursal_tx      VARCHAR(90),
        disbursed_at      TIMESTAMPTZ,

        -- ── Audit timestamps ───────────────────────────────────
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        -- ── Uniqueness constraints ─────────────────────────────
        -- One application per wallet — enforced at DB level
        CONSTRAINT uq_wallet   UNIQUE (wallet_address),

        -- One application per tx — prevents tx signature replay
        CONSTRAINT uq_tx       UNIQUE (tx_signature),

        -- One application per email
        CONSTRAINT uq_email    UNIQUE (email)
      );
    `);

    // ── admins table ───────────────────────────────────────────
    // Staff who can review and approve applications.
    // Created before applications so the FK reference above works.
    // In practice, run the admins migration BEFORE applications.
    // We use CREATE TABLE IF NOT EXISTS so order doesn't matter on re-run.
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         VARCHAR(255) NOT NULL UNIQUE,
        name          VARCHAR(100) NOT NULL,

        -- bcrypt hash of the password — NEVER store plaintext
        password_hash VARCHAR(100) NOT NULL,

        role          VARCHAR(20) NOT NULL DEFAULT 'reviewer'
                      CHECK (role IN ('reviewer','admin','superadmin')),

        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── tx_audit_log table ─────────────────────────────────────
    // Immutable log of every blockchain verification attempt.
    // Even failed / rejected verifications are logged here.
    // This is your source of truth for "what did we check and when?"
    await client.query(`
      CREATE TABLE IF NOT EXISTS tx_audit_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- The wallet that submitted
        wallet_address  VARCHAR(44)  NOT NULL,

        -- The tx they claimed to have sent
        tx_signature    VARCHAR(90)  NOT NULL,

        -- What our verification returned
        -- 'valid' | 'invalid_amount' | 'wrong_recipient' |
        -- 'tx_not_found' | 'tx_too_old' | 'replay_attempt' | 'rpc_error'
        verification_result  VARCHAR(30) NOT NULL,

        -- Raw response from Solana RPC (for debugging)
        rpc_response    JSONB,

        -- IP address of the request (for fraud analysis)
        ip_address      INET,

        -- Linked to an application if one was created
        application_id  UUID REFERENCES applications(id),

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── INDEXES ────────────────────────────────────────────────
    -- Queries we'll run often need indexes or they do full table scans.
    -- Rule: index columns used in WHERE clauses and JOIN conditions.

    -- Admins dashboard: filter by status
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_status
        ON applications (status);
    `);

    -- Look up by wallet (happens on every application submit)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_wallet
        ON applications (wallet_address);
    `);

    -- Audit log lookups by wallet (fraud analysis)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_wallet
        ON tx_audit_log (wallet_address);
    `);

    -- ── updated_at trigger ─────────────────────────────────────
    -- Automatically update updated_at whenever a row changes.
    -- Without this you'd have to remember to set it in every UPDATE query.
    await client.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_applications_updated_at ON applications;
      CREATE TRIGGER trg_applications_updated_at
        BEFORE UPDATE ON applications
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await client.query('COMMIT');
    logger.info('✅ Migration complete — all tables created.');

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('❌ Migration failed — rolled back.', { message: err.message });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
