# Fitness Workout Tracker

A RESTful API for tracking fitness workouts with user authentication and CRUD operations for workout sessions.

## Features
- User sign up and sign in (JWT-based authentication with roles)
- Role-based access control (RBAC): 'user' (own data) vs 'admin' (full access + /admin routes)
- User-specific data storage (SQLite database with role field)
- CRUD operations for workout sessions with Redis caching for GET /workouts (60s TTL, auto-invalidation on mutations)
- Rate limiting: 5 requests per minute per endpoint (Redis-backed, returns 429 on exceed)
- Swagger documentation at `/docs`
- Postman collection examples in `postman.md`

## Tech Stack
- Node.js
- Express.js
- SQLite (persistent storage with roles)
- Redis (caching and rate limiting store)
- JWT for auth (incl. role payload)
- Swagger/OpenAPI
- express-rate-limit

## Setup and Running
1. Clone the repo
2. Install dependencies: `npm install`
3. Ensure Redis is running: `redis-server` (or via service; defaults to localhost:6379)
4. Run the server: `npm run dev` (for development with nodemon) or `npm start`
   - DB auto-migrates role column on startup
5. Server runs at `http://localhost:3000`
6. API docs: `http://localhost:3000/docs`
7. See `postman.md` for endpoint examples
   - Default signup role: 'user'; create admin via `{"role": "admin"}` or DB update

## Endpoints Overview
See `postman.md` and Swagger docs for full details.

### Auth & User Routes (role-aware)
- `POST /signup` - Register (role: user/admin default user; rate limited)
- `POST /signin` - Login (JWT includes role for RBAC; rate limited)
- `POST /workouts` - Create workout (user: own; rate limited)
- `GET /workouts?page=1&limit=10` - List user's workouts paginated (Redis cached per page/limit, 60s TTL, rate limited; default page=1/limit=10)
- `GET /workouts/:id` - Get specific (own only; rate limited)
- `PUT /workouts/:id` - Update workout (full, incl. exercises; rate limited)
- `DELETE /workouts/:id` - Delete workout (rate limited)
- `POST /workouts/:id/comments` - Add comment (rate limited)
- `GET /workouts/:id/comments` - View comments (rate limited)

### Admin-Only Routes (requires role='admin' in JWT)
- `GET /admin/workouts?page=1&limit=10` - Paginated workouts across all users (rate limited; default page=1/limit=10)
- `GET /admin/users` - List all users/roles (rate limited)
- `GET /admin/metrics` - All application logs/metrics from endpoints (for monitoring; rate limited)
- `GET /` - Health check (rate limited)

### Testing Endpoint
- `POST /token` - Get JWT for existing user (same as /signin; convenience for Postman/testing; rate limited)

Data secured by role-based auth; Redis cache keys user-specific; rate limits per endpoint; all requests logged to DB.

## Redis Caching Details
- Cache key: `workouts:user:<userId>`
- TTL: 60 seconds on GET
- Invalidation on POST/PUT/DELETE for consistency
- Graceful fallback to DB if Redis unavailable.

## Rate Limiting Details
- Limit: 5 requests per minute **per endpoint** (e.g., separate for /signup and /workouts).
- Storage: Redis-backed (keys prefixed like `rl:endpoint:...`).
- Headers: Includes `RateLimit-*` in responses.
- On exceed: 429 Too Many Requests (with message).
- Applies to auth, workouts, health, /docs, /token, and /admin/* endpoints.

## RBAC Details
- Roles: 'user' (default; CRUD own workouts) or 'admin' (full access).
- JWT includes role; protected by `requireAdmin` middleware.
- Signup default: 'user' (set "role": "admin" explicitly for admins; secure in prod).

## Logging & Metrics Details
- Middleware: Captures method, endpoint, user_id, status, IP for every request.
- Storage: SQLite `logs` table (auto-created).
- Admin access: `GET /admin/metrics` (latest 100 logs, ordered by timestamp).

## Pagination Details
- Applies to `GET /workouts` (user-specific) and `GET /admin/workouts`.
- Query params: `?page=1&limit=10` (defaults; page >=1, 1<=limit<=100).
- Response: `{ data: [], total, page, limit, totalPages }`; ordered by date DESC; data includes nested `exercises` array.
- Cache: Redis per-page (key: `workouts:user:<id>:page:<p>:limit:<l>`, 60s TTL); invalidates all user pages on mutations.
- DB: Efficient COUNT + LIMIT/OFFSET; fallback on cache error.

## Multi-Exercise Workouts Details
- Workouts now support mixture of exercises (e.g., strength + cardio).
- Schema: Workouts session (date, notes) + linked exercises (name, sets, reps, weight, duration, calories, notes).
- Calorie Section: Each workout includes `total_calories` (aggregated sum from exercises' calories).
- Create: POST /workouts with `exercises: [{name, sets, ..., calories}, ...]` array (required >=1).
- Retrieve: GET endpoints nest `exercises` array + `total_calories` in workout data.
- Update: PUT /workouts/:id fully updateable (session + replace exercises array; recalculates total_calories).
- Delete: Cascade removes exercises.
- Legacy fields (type/duration) deprecated in favor of exercises.

## Commentable Workouts Details
- Each workout supports comments (user-owned).
- Endpoints: POST /workouts/:id/comments (add text), GET /workouts/:id/comments (list with user_email).
- RBAC: Users comment own workouts; admins any.
- Cascade delete: Removing workout deletes comments.
