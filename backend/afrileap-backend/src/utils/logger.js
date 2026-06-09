// src/utils/logger.js
// ─────────────────────────────────────────────────────────────────
// Centralised logger using Winston.
//
// WHY A DEDICATED LOGGER (not console.log)?
//   • console.log has no log levels — you can't filter by severity
//   • In production you want structured JSON logs (easier to parse
//     in Datadog, CloudWatch, Papertrail, etc.)
//   • In development you want pretty, coloured output for readability
//   • Winston handles both with a single config switch on NODE_ENV
// ─────────────────────────────────────────────────────────────────

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, colorize, printf, json, errors } = format;

// Custom pretty format for development
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),  // include stack traces on Error objects
  printf(({ level, message, timestamp, stack, ...meta }) => {
    // Print any extra metadata (like walletAddress, txSignature) inline
    const extras = Object.keys(meta).length
      ? '\n  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')
      : '';
    return `${timestamp} [${level}] ${message}${stack ? '\n' + stack : ''}${extras}`;
  })
);

// Structured JSON format for production (one JSON object per line)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new transports.Console()
  ],
  // Don't crash the process on uncaught exceptions — log them instead
  exitOnError: false
});

module.exports = logger;
