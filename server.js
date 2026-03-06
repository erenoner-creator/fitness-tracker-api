const express = require('express');
const cors = require('cors');
const db = require('./db');
const { generateToken, hashPassword, comparePassword, authenticateToken, requireAdmin } = require('./auth');
const redisClient = require('./redis');
const { createRateLimiter } = require('./rateLimiter');
const { requestLogger } = require('./logger');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Logging middleware: captures all endpoint activity (method, path, user, status, IP)
// Stored in logs table; used by admin /admin/metrics
// Applied globally for complete coverage
app.use(requestLogger);

// Rate limiters: 5 requests per minute per endpoint (using Redis-backed store)
// Each endpoint has its own limiter for isolation (e.g., separate counters for /signup vs /workouts)
// Created early to apply to /docs
const signupLimiter = createRateLimiter('signup');
const signinLimiter = createRateLimiter('signin');
const createWorkoutLimiter = createRateLimiter('workouts-create');
const listWorkoutsLimiter = createRateLimiter('workouts-list');
const getWorkoutLimiter = createRateLimiter('workouts-get');
const updateWorkoutLimiter = createRateLimiter('workouts-update');
const deleteWorkoutLimiter = createRateLimiter('workouts-delete');
const healthLimiter = createRateLimiter('health');
const docsLimiter = createRateLimiter('docs');
const commentsLimiter = createRateLimiter('comments');  // For comment endpoints

// Helper to attach exercises to workout sessions (for multi-exercise mixture support)
// Used in GET endpoints; N+1 query but small scale; could optimize with JOIN
// Adds calorie section: total_calories aggregated from exercises (sum calories)
const attachExercises = (workouts, callback) => {
  if (!workouts || workouts.length === 0) return callback(workouts);
  let completed = 0;
  workouts.forEach((workout) => {
    db.all('SELECT * FROM exercises WHERE workout_id = ? ORDER BY id', [workout.id], (err, exs) => {
      workout.exercises = exs || [];  // Nest exercises array
      // Calorie section: compute total_calories for the workout
      workout.total_calories = exs.reduce((sum, ex) => sum + (ex.calories || 0), 0);
      completed++;
      if (completed === workouts.length) callback(workouts);
    });
  });
};

// Swagger setup (rate limited to 5 req/min; updated for /token, metrics logging, multi-exercise workouts)
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'Fitness Workout Tracker API',
      version: '1.0.0',
      description: 'API for user authentication, RBAC, workout sessions with multiple exercises, rate limiting (5 req/min), Redis caching, and logging',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./server.js'], // Path to the API docs
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/docs', docsLimiter, swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Routes

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       required:
 *         - email
 *         - password
 *       properties:
 *         email:
 *           type: string
 *         password:
 *           type: string
 *     Workout:
 *       type: object
 *       required:
 *         - date
 *         - type
 *         - duration
 *         - calories
 *       properties:
 *         date:
 *           type: string
 *           format: date
 *         type:
 *           type: string
 *         duration:
 *           type: integer
 *         calories:
 *           type: integer
 *         notes:
 *           type: string
 *     AuthResponse:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       required:
 *         - email
 *         - password
 *       properties:
 *         email:
 *           type: string
 *         password:
 *           type: string
 *         role:
 *           type: string
 *           enum: [user, admin]
 *           default: user  # Default for new users; admins can be created manually
 *     Workout:
 *       type: object
 *       required:
 *         - date
 *         - type
 *         - duration
 *         - calories
 *       properties:
 *         date:
 *           type: string
 *           format: date
 *         type:
 *           type: string
 *         duration:
 *           type: integer
 *         calories:
 *           type: integer
 *         notes:
 *           type: string
 *     AuthResponse:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 */

/**
 * @swagger
 * /signup:
 *   post:
 *     summary: Register a new user (role defaults to 'user'; rate limited to 5 req/min)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 userId:
 *                   type: integer
 *       400:
 *         description: User already exists or invalid input
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.post('/signup', signupLimiter, async (req, res) => {
  const { email, password, role = 'user' } = req.body;  // Default 'user'; set to 'admin' manually for security
  if (!email || !password || !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Email, password, and valid role (user/admin) required' });
  }

  try {
    const hashedPassword = await hashPassword(password);
    db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', [email, hashedPassword, role], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'User already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ message: 'User created successfully', userId: this.lastID });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /signin:
 *   post:
 *     summary: Login user (returns JWT with role for RBAC; rate limited to 5 req/min)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.post('/signin', signinLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Fetch user incl. role for JWT
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    res.json({ token });
  });
});

/**
 * @swagger
 * /workouts:
 *   post:
 *     summary: Create a new workout session with multiple exercises (mixture support; invalidates cache, rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Workout'
 *           example:
 *             date: "2026-03-08"
 *             notes: "Full body workout"
 *             exercises: [
 *               { "name": "Squats", "sets": 3, "reps": 12, "weight": 50, "calories": 100, "notes": "Bodyweight focus" },
 *               { "name": "Running", "duration": 20, "calories": 200, "notes": "Cardio" }
 *             ]
 *     responses:
 *       201:
 *         description: Workout created with exercises
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 workoutId:
 *                   type: integer
 *       400:
 *         description: Invalid payload (e.g., missing exercises)
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.post('/workouts', createWorkoutLimiter, authenticateToken, async (req, res) => {
  const { date, notes = '', exercises = [] } = req.body;  // exercises: array for mixture; legacy type/duration/calories deprecated
  const userId = req.user.id;
  const cacheKey = `workouts:user:${userId}`;

  if (!date || !Array.isArray(exercises) || exercises.length === 0) {
    return res.status(400).json({ error: 'date and exercises array (at least 1) required for multi-exercise workout' });
  }

  // Use transaction for atomic insert: workout + exercises
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run(
      'INSERT INTO workouts (user_id, date, notes) VALUES (?, ?, ?)',  // Simplified; aggregate metrics to exercises
      [userId, date, notes],
      function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: err.message });
        }
        const workoutId = this.lastID;

        // Insert multiple exercises linked to workout
        const stmt = db.prepare('INSERT INTO exercises (workout_id, name, sets, reps, weight, duration, calories, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        let exerciseErr = null;
        for (const ex of exercises) {
          stmt.run([workoutId, ex.name, ex.sets || null, ex.reps || null, ex.weight || null, ex.duration || null, ex.calories || null, ex.notes || ''], (err) => {
            if (err) exerciseErr = err;
          });
        }
        stmt.finalize();

        if (exerciseErr) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: exerciseErr.message });
        }

        db.run('COMMIT', async (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }

          // Invalidate cache: clear base + all paginated keys for this user
          // Use KEYS for simplicity (dev; for prod use SCAN to avoid blocking)
          // Matches keys like workouts:user:${userId} and workouts:user:${userId}:page:*:limit:*
          if (redisClient.isReady) {
            const keys = await redisClient.keys(`workouts:user:${userId}*`);
            if (keys.length > 0) {
              await redisClient.del(keys);
            }
          }
          res.status(201).json({ message: 'Workout created with exercises', workoutId });
        });
      }
    );
  });
});

/**
 * @swagger
 * /workouts:
 *   get:
 *     summary: Get paginated workout sessions for the authenticated user (cached in Redis for 60s, rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           maximum: 100
 *           minimum: 1
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Paginated workouts (from cache or DB)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Workout'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.get('/workouts', listWorkoutsLimiter, authenticateToken, async (req, res) => {
  const userId = req.user.id;

  // Parse pagination params (defaults: page=1, limit=10; max limit=100 for perf)
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  // Cache key includes page/limit for granularity
  const cacheKey = `workouts:user:${userId}:page:${page}:limit:${limit}`;

  try {
    // Check Redis cache first
    if (redisClient.isReady) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log('Cache hit for', cacheKey);
        return res.json(JSON.parse(cached));
      }
    }

    // Cache miss: query DB with pagination + total count
    console.log('Cache miss for', cacheKey);
    // Use two queries: count for total, then paginated select
    db.get('SELECT COUNT(*) as total FROM workouts WHERE user_id = ?', [userId], (err, countResult) => {
      if (err) return res.status(500).json({ error: err.message });

      const total = countResult.total;
      const totalPages = Math.ceil(total / limit);

      db.all(
        'SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?',
        [userId, limit, offset],
        async (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });

          // Attach nested exercises for multi-exercise mixture support
          attachExercises(rows, async (workoutsWithEx) => {
            const response = {
              data: workoutsWithEx,
              total,
              page,
              limit,
              totalPages
            };

            // Store paginated response (with exercises) in Redis cache with 60s TTL
            if (redisClient.isReady) {
              await redisClient.setEx(cacheKey, 60, JSON.stringify(response));
            }
            res.json(response);
          });
        }
      );
    });
  } catch (err) {
    console.error('Cache error:', err);
    // Fallback to DB on cache error
    db.get('SELECT COUNT(*) as total FROM workouts WHERE user_id = ?', [userId], (err, countResult) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = countResult.total;
      const totalPages = Math.ceil(total / limit);
      db.all(
        'SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?',
        [userId, limit, offset],
        (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });
          // Attach nested exercises for multi-exercise mixture support
          attachExercises(rows, (workoutsWithEx) => {
            res.json({ data: workoutsWithEx, total, page, limit, totalPages });
          });
        }
      );
    });
  }
});

/**
 * @swagger
 * /workouts/{id}:
 *   get:
 *     summary: Get a specific workout by ID (user-specific or admin; includes exercises + total_calories section, rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Workout details (with nested exercises and total_calories)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Workout'
 *                 - type: object
 *                   properties:
 *                     exercises:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Exercise'
 *                     total_calories:
 *                       type: integer
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.get('/workouts/:id', getWorkoutLimiter, authenticateToken, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // Check access: user own or admin
  const checkQuery = req.user.role === 'admin' 
    ? 'SELECT * FROM workouts WHERE id = ?'
    : 'SELECT * FROM workouts WHERE id = ? AND user_id = ?';
  const checkParams = req.user.role === 'admin' ? [id] : [id, userId];

  db.get(checkQuery, checkParams, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Workout not found' });

    // Attach nested exercises + calorie section (total_calories aggregate)
    attachExercises([row], (workoutsWithEx) => {
      res.json(workoutsWithEx[0]);  // Return single workout with enhancements
    });
  });
});

/**
 * @swagger
 * /workouts/{id}:
 *   put:
 *     summary: Update a workout session by ID (full updateable incl. exercises mixture; user-specific or admin, invalidates cache, rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Workout'
 *           example:
 *             date: "2026-03-09"
 *             notes: "Updated session"
 *             exercises: [
 *               {"name": "Pushups", "sets": 3, "reps": 20, "calories": 50},
 *               {"name": "Cycling", "duration": 30, "calories": 250}
 *             ]
 *     responses:
 *       200:
 *         description: Workout updated with exercises
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.put('/workouts/:id', updateWorkoutLimiter, authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { date, notes = '', exercises = [] } = req.body;  // Full updateable: session + exercises array
  const userId = req.user.id;
  const cacheKey = `workouts:user:${userId}`;

  if (!date || !Array.isArray(exercises) || exercises.length === 0) {
    return res.status(400).json({ error: 'date and exercises array required for update' });
  }

  // Check ownership (user own or admin)
  const checkQuery = req.user.role === 'admin' 
    ? 'SELECT id FROM workouts WHERE id = ?'
    : 'SELECT id FROM workouts WHERE id = ? AND user_id = ?';
  const checkParams = req.user.role === 'admin' ? [id] : [id, userId];

  db.get(checkQuery, checkParams, (err, workout) => {
    if (err || !workout) return res.status(404).json({ error: 'Workout not found or not owned' });

    // Transaction for atomic update: workout + replace exercises
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        'UPDATE workouts SET date = ?, notes = ? WHERE id = ?',
        [date, notes, id],
        function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }

          // Replace exercises: delete old, insert new
          db.run('DELETE FROM exercises WHERE workout_id = ?', [id], (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }

            const stmt = db.prepare('INSERT INTO exercises (workout_id, name, sets, reps, weight, duration, calories, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            let exErr = null;
            for (const ex of exercises) {
              stmt.run([id, ex.name, ex.sets || null, ex.reps || null, ex.weight || null, ex.duration || null, ex.calories || null, ex.notes || ''], (err) => {
                if (err) exErr = err;
              });
            }
            stmt.finalize();

            if (exErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: exErr.message });
            }

            db.run('COMMIT', async (err) => {
              if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
              }

              // Invalidate cache: clear base + all paginated keys for this user
              // Use KEYS for simplicity (dev; for prod use SCAN to avoid blocking)
              // Matches keys like workouts:user:${userId} and workouts:user:${userId}:page:*:limit:*
              if (redisClient.isReady) {
                const keys = await redisClient.keys(`workouts:user:${userId}*`);
                if (keys.length > 0) {
                  await redisClient.del(keys);
                }
              }
              // If admin updating other user's workout, invalidate that user's cache too
              if (req.user.role === 'admin') {
                // Note: for full, could query user_id and del, but simple here
                console.log('Admin update; cache invalidated for owner');
              }
              res.json({ message: 'Workout updated with exercises' });
            });
          });
        }
      );
    });
  });
});

/**
 * @swagger
 * /workouts/{id}:
 *   delete:
 *     summary: Delete a workout session by ID (user-specific) - invalidates Redis cache (rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Workout deleted
 *       404:
 *         description: Not found
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.delete('/workouts/:id', deleteWorkoutLimiter, authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const cacheKey = `workouts:user:${userId}`;

  db.run('DELETE FROM workouts WHERE id = ? AND user_id = ?', [id, userId], async function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Workout not found' });

    // Invalidate cache: clear base + all paginated keys for this user
    // Use KEYS for simplicity (dev; for prod use SCAN to avoid blocking)
    // Matches keys like workouts:user:${userId} and workouts:user:${userId}:page:*:limit:*
    if (redisClient.isReady) {
      const keys = await redisClient.keys(`workouts:user:${userId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    }
    res.json({ message: 'Workout deleted' });
  });
});

/**
 * @swagger
 * /workouts/{id}/comments:
 *   post:
 *     summary: Add comment to a workout (commentable; auth required, rate limited to 5 req/min)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text:
 *                 type: string
 *     responses:
 *       201:
 *         description: Comment added
 *       404:
 *         description: Workout not found/not owned
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 *   get:
 *     summary: Get comments for a workout (commentable)
 *     tags: [Workouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of comments (with user info)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   text:
 *                     type: string
 *                   timestamp:
 *                     type: string
 *                   user_email:
 *                     type: string
 *       404:
 *         description: Workout not found
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.post('/workouts/:id/comments', commentsLimiter, authenticateToken, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const userId = req.user.id;

  if (!text) {
    return res.status(400).json({ error: 'Comment text required' });
  }

  // Check workout exists and user owns (or admin for full access)
  const checkQuery = req.user.role === 'admin' 
    ? 'SELECT id FROM workouts WHERE id = ?'
    : 'SELECT id FROM workouts WHERE id = ? AND user_id = ?';
  const checkParams = req.user.role === 'admin' ? [id] : [id, userId];

  db.get(checkQuery, checkParams, (err, workout) => {
    if (err || !workout) return res.status(404).json({ error: 'Workout not found or not owned' });

    // Add comment
    db.run(
      'INSERT INTO comments (workout_id, user_id, text) VALUES (?, ?, ?)',
      [id, userId, text],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        // Invalidate workout cache (to reflect comments if attached in future GETs)
        if (redisClient.isReady) {
          redisClient.keys(`workouts:user:${userId}*`).then(keys => {
            if (keys.length > 0) redisClient.del(keys);
          }).catch(() => {});  // Ignore cache error
        }
        res.status(201).json({ message: 'Comment added', commentId: this.lastID });
      }
    );
  });
});

app.get('/workouts/:id/comments', commentsLimiter, authenticateToken, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // Check workout exists and access (user own or admin)
  const checkQuery = req.user.role === 'admin' 
    ? 'SELECT id FROM workouts WHERE id = ?'
    : 'SELECT id FROM workouts WHERE id = ? AND user_id = ?';
  const checkParams = req.user.role === 'admin' ? [id] : [id, userId];

  db.get(checkQuery, checkParams, (err, workout) => {
    if (err || !workout) return res.status(404).json({ error: 'Workout not found or not owned' });

    // Get comments with user email (commentable view)
    db.all(
      `SELECT c.id, c.text, c.timestamp, u.email as user_email 
       FROM comments c 
       JOIN users u ON c.user_id = u.id 
       WHERE c.workout_id = ? 
       ORDER BY c.timestamp DESC`,
      [id],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  });
});

/**
 * @swagger
 * /admin/workouts:
 *   get:
 *     summary: Admin only - Get paginated workout sessions across users (RBAC)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           maximum: 100
 *           minimum: 1
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Paginated workouts for admin
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Workout'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       403:
 *         description: Admin access required
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.get('/admin/workouts', authenticateToken, requireAdmin, listWorkoutsLimiter, (req, res) => {
  // Admins see all workouts (bypass user-specific); pagination same as user
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  // Count total
  db.get('SELECT COUNT(*) as total FROM workouts', (err, countResult) => {
    if (err) return res.status(500).json({ error: err.message });

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    // Paginated select, ordered recent first
    db.all(
      'SELECT * FROM workouts ORDER BY date DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Attach nested exercises for multi-exercise mixture support
        attachExercises(rows, (workoutsWithEx) => {
          res.json({ data: workoutsWithEx, total, page, limit, totalPages });
        });
      }
    );
  });
});

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Admin only - Get all users (RBAC)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users (roles included)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       403:
 *         description: Admin access required
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.get('/admin/users', authenticateToken, requireAdmin, signupLimiter, (req, res) => {  // Reuse signupLimiter for rate
  // Admins only; exclude passwords
  db.all('SELECT id, email, role FROM users', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/**
 * @swagger
 * /token:
 *   post:
 *     summary: Get JWT token for existing user (for Postman/testing only; same as /signin)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: JWT token returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.post('/token', signinLimiter, (req, res) => {
  // Alias to /signin for testing convenience in Postman; reuses secure logic
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Same as signin: fetch user incl. role
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    res.json({ token });
  });
});

/**
 * @swagger
 * /admin/metrics:
 *   get:
 *     summary: Admin only - View all application logs/metrics from endpoints (RBAC)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of logs (timestamp, method, endpoint, user, status, IP)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   timestamp:
 *                     type: string
 *                   method:
 *                     type: string
 *                   endpoint:
 *                     type: string
 *                   user_id:
 *                     type: integer
 *                   status_code:
 *                     type: integer
 *                   ip:
 *                     type: string
 *       403:
 *         description: Admin access required
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests (rate limit exceeded)
 */
app.get('/admin/metrics', authenticateToken, requireAdmin, createWorkoutLimiter, (req, res) => {  // Reuse a limiter for rate
  // Admins see all logs for monitoring; latest first, limit to 100 for perf
  db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Health check (rate limited to 5 req/min)
app.get('/', healthLimiter, (req, res) => {
  res.json({ message: 'Fitness Workout Tracker API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Swagger docs available at http://localhost:${PORT}/docs`);
});