const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('./redis');

// Factory for per-endpoint rate limiter: 5 requests per minute, using Redis for storage
// Separate keys per endpoint/path to enforce independently
const createRateLimiter = (endpointName) => {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // Limit each IP/endpoint to 5 requests per window
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args), // Compatible with redis@4 client
      prefix: `rl:${endpointName}:`, // Unique prefix per endpoint for isolation
    }),
    keyGenerator: (req) => {
      // Key by IP (using helper for IPv6 support) + optional userId (for auth'd routes) for finer control
      // Prevents IPv6 bypass; see https://express-rate-limit.github.io/ERR_ERL_KEY_GEN_IPV6/
      const userId = req.user ? req.user.id : 'anonymous';
      return `${ipKeyGenerator(req)}:${userId}`;
    },
    message: {
      error: 'Too many requests from this IP for this endpoint. Please try again after 1 minute.',
    },
    handler: (req, res) => {
      res.status(429).json({
        error: 'Too many requests from this IP for this endpoint. Please try again after 1 minute.',
      });
    },
  });
};

module.exports = { createRateLimiter };