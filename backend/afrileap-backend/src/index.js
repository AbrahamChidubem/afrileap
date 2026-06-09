// src/index.js
// ─────────────────────────────────────────────────────────────────
// ENTRY POINT — wires everything together into a running server.
//
// STARTUP SEQUENCE:
//   1. Load env vars
//   2. Create Express app
//   3. Attach security middleware (helmet, cors, rate limiting)
//   4. Attach body parsers
//   5. Mount routes
//   6. Attach error handler
//   7. Connect to DB (verify connection)
//   8. Hydrate in-memory caches
//   9. Start listening
//
// We validate the environment before starting. A server that starts
// with a missing TREASURY_WALLET would accept applications but fail
// every verification — better to crash loud at boot time.
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const logger       = require('./utils/logger');
const { checkConnection } = require('./db/pool');
const { hydrateUsedSignatures } = require('./services/applicationService');

// ─── ENVIRONMENT VALIDATION ───────────────────────────────────
// Fail fast if required env vars are missing. Much better than
// mysterious runtime errors 30 minutes into production.
const REQUIRED_ENV = [
  'DATABASE_URL',
  'SOLANA_RPC_URL',
  'TREASURY_WALLET_ADDRESS',
  'USDC_MINT_ADDRESS',
];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  logger.error('Missing required environment variables — cannot start', { missing });
  process.exit(1);
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3001');

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────

// Helmet sets security-relevant HTTP response headers:
//   X-Frame-Options: DENY              → prevents clickjacking
//   X-Content-Type-Options: nosniff   → prevents MIME sniffing
//   Strict-Transport-Security         → forces HTTPS
//   Content-Security-Policy           → restricts resource loading
//   ... and ~10 more
app.use(helmet());

// CORS — who is allowed to call this API?
// In production: lock this down to your actual frontend domain.
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('CORS blocked request from unlisted origin', { origin });
    callback(new Error(`Origin ${origin} not allowed by CORS policy`));
  },
  methods:     ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // we don't use cookies
}));

// Rate limiting — prevents spam / DDoS on the API.
// Applies globally to all routes. You can add stricter limits per-route.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 min
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20'),  // per IP
  standardHeaders: true,  // adds RateLimit-* headers to responses
  legacyHeaders: false,
  message: {
    success: false,
    error:   'Too many requests from this IP. Please wait 15 minutes and try again.'
  },
  // Custom key: use IP, but also consider wallet address for more granular limits
  keyGenerator: (req) => req.ip,
  skip: (req) => {
    // Don't rate-limit the health endpoint (it's called by load balancers constantly)
    return req.path === '/health';
  }
});
app.use(limiter);

// ─── BODY PARSERS ─────────────────────────────────────────────
// Parse JSON request bodies. Limit size to 50kb to prevent large
// payload attacks — our payloads are tiny (< 2kb), so 50kb is generous.
app.use(express.json({ limit: '50kb' }));

// ─── REQUEST LOGGING ──────────────────────────────────────────
// Log every incoming request: method, path, IP, response time.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';
    logger[level](`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
});

// ─── ROUTES ───────────────────────────────────────────────────
app.use('/health',           require('./routes/health'));
app.use('/api/applications', require('./routes/applications'));

// 404 handler — for routes that don't match anything above
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   `Route ${req.method} ${req.path} not found`
  });
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────
// Express calls this when a route handler calls next(err) or throws
// in an async handler wrapped with express-async-errors.
// The 4-argument signature is what tells Express this is an error handler.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // CORS errors from our cors() config
  if (err.message?.includes('not allowed by CORS')) {
    return res.status(403).json({ success: false, error: err.message });
  }

  logger.error('Unhandled application error', {
    message: err.message,
    stack:   err.stack,
    path:    req.path,
    method:  req.method
  });

  return res.status(500).json({
    success: false,
    error:   process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// ─── STARTUP ──────────────────────────────────────────────────
async function start() {
  try {
    // Verify DB connection before accepting traffic
    logger.info('Checking database connection…');
    await checkConnection();
    logger.info('✅ Database connected');

    // Load used tx signatures into memory cache
    logger.info('Hydrating tx signature cache…');
    await hydrateUsedSignatures();

    // Start listening
    app.listen(PORT, () => {
      logger.info(`🚀 AfriLeap API running`, {
        port:        PORT,
        environment: process.env.NODE_ENV || 'development',
        cluster:     process.env.SOLANA_CLUSTER || 'devnet',
        treasury:    process.env.TREASURY_WALLET_ADDRESS?.slice(0, 8) + '…'
      });
    });

  } catch (err) {
    logger.error('Startup failed', { message: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────
// When the process receives SIGTERM (e.g. Ctrl+C, container stop),
// stop accepting new requests but finish in-flight ones.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
});

start();

module.exports = app; // export for tests
