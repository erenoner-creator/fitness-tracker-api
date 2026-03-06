# Postman Documentation for Fitness Workout Tracker API

This document provides example endpoints and payloads for testing the API using Postman. The base URL is `http://localhost:3000`.

**Rate Limiting Note**: Each endpoint is limited to 5 requests per minute (Redis-backed, per-endpoint counters). Exceeding returns HTTP 429 with error message. Check `RateLimit-*` headers and server logs. See README.md for details.

## Authentication Endpoints

### 1. Sign Up
- **Method**: POST
- **Endpoint**: `/signup`
- **Headers**: `Content-Type: application/json`
- **Body** (raw JSON):
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```
- **Expected Response**: 201 Created
  ```json
  {
    "message": "User created successfully",
    "userId": 1
  }
  ```
- **Notes**: Creates a new user. Email must be unique. Rate limited to 5 req/min (returns 429 if exceeded).

### 2. Sign In
- **Method**: POST
- **Endpoint**: `/signin`
- **Headers**: `Content-Type: application/json`
- **Body** (raw JSON):
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```
- **Expected Response**: 200 OK
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Notes**: Returns JWT token. Use this token in subsequent requests. Rate limited to 5 req/min (returns 429 if exceeded).

## Workout Sessions CRUD (Requires Authentication)

Include the token in headers: `Authorization: Bearer <your_token_here>`

**Notes**:
- **Caching**: GET /workouts is cached in Redis (key: `workouts:user:<userId>`, TTL 60s) for performance. Mutations (POST/PUT/DELETE) automatically invalidate the cache. Check server logs for "Cache hit"/"Cache miss". Fallback to DB if Redis unavailable.
- **Rate Limiting**: Each endpoint (e.g., POST /workouts, GET /workouts) limited to 5 req/min (Redis-backed, per-endpoint). Exceeding returns 429; check `RateLimit-*` headers.

### 3. Create Workout (POST) - With Multiple Exercises
- **Method**: POST
- **Endpoint**: `/workouts`
- **Headers**: 
  - `Content-Type: application/json`
  - `Authorization: Bearer <token>`
- **Body** (raw JSON): Supports mixture of exercises (required array)
  ```json
  {
    "date": "2026-03-08",
    "notes": "Full body session",
    "exercises": [
      {
        "name": "Squats",
        "sets": 3,
        "reps": 12,
        "weight": 50,
        "calories": 100,
        "notes": "Focus on form"
      },
      {
        "name": "Running",
        "duration": 20,
        "calories": 200,
        "notes": "Cardio interval"
      }
    ]
  }
  ```
- **Expected Response**: 201 Created
  ```json
  {
    "message": "Workout created with exercises",
    "workoutId": 1
  }
  ```
- **Notes**: Creates workout session + linked exercises; invalidates user's workout cache in Redis. Legacy fields (type/duration) deprecated.

### 4. Get All Workouts (GET) - Paginated (Includes Nested Exercises)
- **Method**: GET
- **Endpoint**: `/workouts?page=1&limit=10` (defaults: page=1, limit=10; max limit=100)
- **Headers**: 
  - `Authorization: Bearer <token>`
- **Expected Response**: 200 OK
  ```json
  {
    "data": [
      {
        "id": 1,
        "user_id": 1,
        "date": "2026-03-08",
        "notes": "Full body session",
        "exercises": [
          {
            "id": 1,
            "workout_id": 1,
            "name": "Squats",
            "sets": 3,
            "reps": 12,
            "weight": 50,
            "duration": null,
            "calories": 100,
            "notes": "Focus on form"
          },
          {
            "id": 2,
            "workout_id": 1,
            "name": "Running",
            "sets": null,
            "reps": null,
            "weight": null,
            "duration": 20,
            "calories": 200,
            "notes": "Cardio interval"
          }
        ],
        "total_calories": 300
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
  ```
- **Notes**: Returns paginated workouts for the authenticated user (ordered recent first; exercises nested + `total_calories` section aggregated from exercises calories). Supports ?page= &limit= . First hit: DB query (COUNT + LIMIT/OFFSET + exercises join) + cache set; subsequent: Redis cache hit (per-page key; check server logs).

### 5. Get Specific Workout (GET)
- **Method**: GET
- **Endpoint**: `/workouts/{id}` (e.g., `/workouts/1`)
- **Headers**: 
  - `Authorization: Bearer <token>`
- **Expected Response**: 200 OK (workout details incl. nested exercises) or 404 if not found/not owned by user.

### 6. Update Workout (PUT) - Full Updateable with Exercises
- **Method**: PUT
- **Endpoint**: `/workouts/{id}` (e.g., `/workouts/1`)
- **Headers**: 
  - `Content-Type: application/json`
  - `Authorization: Bearer <token>`
- **Body** (raw JSON): Full update incl. exercises mixture
  ```json
  {
    "date": "2026-03-09",
    "notes": "Updated session",
    "exercises": [
      {
        "name": "Pushups",
        "sets": 3,
        "reps": 20,
        "calories": 50
      },
      {
        "name": "Cycling",
        "duration": 30,
        "calories": 250
      }
    ]
  }
  ```
- **Expected Response**: 200 OK
  ```json
  {
    "message": "Workout updated with exercises"
  }
  ```
- **Notes**: Updates session + replaces exercises; invalidates cache; RBAC (own or admin).

### 7. Delete Workout (DELETE)
- **Method**: DELETE
- **Endpoint**: `/workouts/{id}` (e.g., `/workouts/1`)
- **Headers**: 
  - `Authorization: Bearer <token>`
- **Expected Response**: 200 OK
  ```json
  {
    "message": "Workout deleted"
  }
  ```
- **Notes**: Invalidates cache; cascades delete exercises/comments.

### 8. Add Comment to Workout (POST)
- **Method**: POST
- **Endpoint**: `/workouts/{id}/comments` (e.g., `/workouts/1/comments`)
- **Headers**: 
  - `Content-Type: application/json`
  - `Authorization: Bearer <token>`
- **Body** (raw JSON):
  ```json
  {
    "text": "Great workout session!"
  }
  ```
- **Expected Response**: 201 Created
  ```json
  {
    "message": "Comment added",
    "commentId": 1
  }
  ```
- **Notes**: Users add to own workouts; admins to any; rate limited; cache invalidate.

### 9. Get Workout Comments (GET)
- **Method**: GET
- **Endpoint**: `/workouts/{id}/comments` (e.g., `/workouts/1/comments`)
- **Headers**: 
  - `Authorization: Bearer <token>`
- **Expected Response**: 200 OK
  ```json
  [
    {
      "id": 1,
      "text": "Great workout session!",
      "timestamp": "2026-03-08T...",
      "user_email": "user@example.com"
    }
  ]
  ```
- **Notes**: View comments; RBAC (own workout or admin); rate limited.

## Additional Endpoints
### Admin-Only Endpoints (RBAC: requires role='admin' in JWT token)
- **GET /admin/workouts?page=1&limit=10**: Paginated workouts across all users (rate limited; defaults page=1/limit=10).
- **GET /admin/users**: List all users with roles (excludes passwords; rate limited).
- **GET /admin/metrics**: View all app logs/metrics (timestamp, method, endpoint, user_id, status, IP from every request; latest 100; rate limited).
- **Health Check**: GET `/` - Returns API status (rate limited).
- **Swagger Docs**: GET `/docs` - Interactive API documentation (rate limited).

### Testing Endpoint
- **POST /token**: Get JWT for existing user (convenience alias to /signin; body: {email, password}; for Postman ease; rate limited).

## Testing Tips
1. Sign up: Use `{"email": "...", "password": "...", "role": "user"}` (default) or "admin" for full access.
2. **/token or /signin**: To get JWT (includes role); ideal for Postman token setup.
3. Use token for /workouts (users: own data only) or /admin/* (admins only; else 403).
4. Data is user-specific for 'user' role; admins see all (incl. metrics/logs).
5. Observe Redis caching in server console logs (Cache hit/miss); logs in DB (`SELECT * FROM logs`).
6. **Rate Limiting Test**: Send 6+ requests to any endpoint (e.g., /signin) quickly – expect 429 after 5. Check `RateLimit-Remaining` headers and Redis keys (e.g., `rl:signin:*`).
7. **RBAC Test**: Login as 'user' (can't access /admin/workouts -> 403); as 'admin' (full access).
8. **Pagination Test**: GET /workouts?page=2&limit=5 (or /admin/workouts as admin); check data/totalPages. Observe cache hit/miss logs.
9. **Metrics Test**: As admin, GET /admin/metrics after API calls to see logged activity from all endpoints.
10. **Comments Test**: POST /workouts/{id}/comments then GET to view; admin can comment on any.
11. **Update Test**: PUT /workouts/{id} with exercises array to fully update.
12. Import this into Postman collections for easy testing (set env for tokens/roles).