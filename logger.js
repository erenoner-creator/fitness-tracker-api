const db = require('./db');

// Logging middleware to capture all endpoint activity for metrics
// Logs: method, endpoint, user_id (if auth'd), status, IP
// Used for admin /admin/metrics
const requestLogger = (req, res, next) => {
  // Capture after response finishes to get statusCode
  res.on('finish', () => {
    const userId = req.user ? req.user.id : null;
    const log = {
      method: req.method,
      endpoint: req.originalUrl || req.url,
      user_id: userId,
      status_code: res.statusCode,
      ip: req.ip || req.connection.remoteAddress
    };

    // Insert to logs table (async, fire-and-forget; errors logged only)
    db.run(
      'INSERT INTO logs (method, endpoint, user_id, status_code, ip) VALUES (?, ?, ?, ?, ?)',
      [log.method, log.endpoint, log.user_id, log.status_code, log.ip],
      (err) => {
        if (err) {
          console.error('Logging error:', err.message);  // Don't block response
        }
      }
    );
  });

  next();  // Continue request
};

module.exports = { requestLogger };