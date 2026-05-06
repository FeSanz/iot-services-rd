# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the service

```bash
npm install
node index.js          # starts HTTP API + WebSocket + MQTT client
```

There is no test, lint, or build script (`package.json` `test` is a placeholder). The single entrypoint is `index.js` and `PORT` defaults to 3000.

Required `.env` keys (see `.env` for live values; do not commit changes):
- `DATABASE_URL` — Postgres connection (currently Render-hosted Postgres with self-signed SSL; `pool.js` sets `rejectUnauthorized: false`).
- `JWT_SECRET`, `JWT_EXPIRES_IN` (default `8h`).
- `FIREBASE_*` — service-account fields for FCM push (`notifications.js` reconstructs the credential object from these envs and calls `\\n → \n` on the private key).
- `SMTP_*` — Nodemailer transport for alert emails.

MQTT broker config is **not** in `.env`. It is read at startup from the `mes_settings` table (`type='MQTT'`, `enabled_flag='Y'`), expecting rows named `MQTT_BROKER`, `MQTT_PORT`, `MQTT_CREDENTIALS` (the last is base64 `user:pass`). If those rows are missing the MQTT client logs and skips initialization but the HTTP server still starts.

## Architecture

This is a Node.js/Express backend that fronts a MES + IIoT platform. Three transport layers run in the same process and share the same Postgres pool:

1. **HTTP REST** (`index.js`) — all routers mounted at `/api`. Two domain folders:
   - `services/iot/*` — IoT-side: `auth`, `users`, `machines`, `sensors`, `sensor_data`, `alerts`, `failtures` (sic), `notifications`, `dashboards`, `dashboardGroups`.
   - `services/fusion/*` — ERP/Oracle-Fusion-side: `organizations`, `companies`, `work_orders`, `work_execution`, `dispatch_orders`, `resources`, `work_centers`, `items`, `shifts`, `campaigns`, `codes`, `integrations`.
   - `services/mqtt/mqtt_routes.js` exposes `/api/mqtt/status` and `/api/mqtt/publish` for ops/debug.

2. **WebSocket** (`services/websocket/websocket.js`) — piggybacks on the same HTTP server. Clients send a JSON `{ typews, ... }` subscription message; the server tags the socket with `suscribedSensorId` / `suscribedOrganization` / `subscribedOrganizationId` + `wsType`. Use the exported `notifySensorData`, `notifyAlert`, `notifyNewWorkOrders`, `notifyWorkOrdersAdvance` to broadcast — they filter `wss.clients` by those tags. Note the typo `suscribed*` (Spanish spelling) on the sensor/alerts channels vs `subscribed*` on the workorders channels — preserve the existing names when adding subscriptions.

3. **MQTT** (`services/mqtt/mqtt_client.js`) — subscribes to `mes/+/erp/woCompleted`, `mes/+/iot/sensorData`, `mes/+/iot/sensorsData`. Topic structure is `mes/{companyId}/{module}/{action}`. `routeMessage()` dispatches by `module`/`action`. **Critical pattern:** the actual business logic lives in `services/handlers/*` (`work_execution_handler.js`, `sensor_data_handler.js`) and is shared between the MQTT route and the HTTP route — when adding a new flow that should be reachable both ways, put logic in a handler and have both transports call it. Responses to ERP messages are published back on `mes/{companyId}/erp/woCompleted/response`.

### Database access

- `database/pool.js` is a singleton `pg.Pool`. Most files `require` it directly and call `pool.query(...)` with parameterized queries.
- `models/sql-execute.js` provides two thin wrappers (`selectFromDB`, `selectByParamsFromDB`) that return the canonical envelope (see below). Newer/simpler routes use these; older or custom-shape routes call `pool.query` directly. Both styles coexist — match the surrounding file.
- `models/date-format.js` — ISO ↔ Postgres timestamp helpers; use these instead of ad-hoc `new Date(...)` formatting when round-tripping ISO strings to/from `TIMESTAMP` columns.
- Schema lives in `assets/db/{tables,indices,triggers,timezone}.sql`. Tables are `MES_*` (companies, users, organizations, machines, sensors, sensor_data, work_orders, work_execution, settings, users_org, user_push_tokens, …). These SQL files are reference-only; they are not auto-applied.

### Auth

- `POST /api/login` (in `services/iot/auth.js`) returns `{ token, items: { …, Company: { Organizations, Settings } } }`. The login query joins `mes_users → mes_users_org → mes_organizations → mes_companies` and aggregates organizations + settings into the response. Passwords are currently compared as plaintext (`password === user.password`) — `bcrypt` is in `dependencies` but not yet wired in.
- Most non-auth routes use `middleware/authenticateToken.js`. It verifies the JWT, then consults the in-memory `tokenService` blacklist. Two revocation modes: per-`jti` (blacklist) and per-user (`revokeAllUserTokens` records `revokedAt` and rejects anything with `iat * 1000 < revokedAt`). **Caveat:** the blacklist lives in process memory only — restarting the server clears all revocations, and a multi-instance deploy would not share state. Keep this in mind before recommending revocation as a security boundary.
- Token expiry surfaces as **HTTP 440** (custom code), distinct from 401 for invalid/missing tokens.

### Response envelope

The standard JSON shape is:
```json
{ "errorsExistFlag": false, "message": "OK", "totalResults": <n>, "items": <object|array|null> }
```
Some older sensor-data routes still return `existError` (no `s`) instead of `errorsExistFlag` — when touching those, prefer aligning to the `errorsExistFlag` form unless the caller specifically depends on the legacy field.

### Cross-cutting notification fan-out

When a domain event fires, multiple sinks may need to be notified:
- WebSocket → `notify*` from `services/websocket/websocket.js`.
- Push → `services/iot/notifications.js` (`sendNotification`) uses Firebase Admin and looks up FCM tokens via `mes_user_push_tokens ⋈ mes_users_org`.
- Email → `services/email/email.js` (`sendEmailNotification`) joins `mes_users ⋈ mes_users_org` and sends via Nodemailer.

All three are organization-scoped — pass the `organization_id` and they fan out to every enabled user under it.

## Conventions in this repo

- Comments, log lines, and user-facing messages are in **Spanish** — match that when adding new ones.
- Console logging uses bracketed prefixes: `[MQTT]`, `[NODE]`, `[MQTT-ERP]`, `[MQTT-IOT]`. Reuse the convention for new subsystems.
- Column names returned to the API are PascalCase (aliased via `AS "WorkOrderId"`), while DB columns themselves are `snake_case`. Many queries hand-build a JSON shape with `json_agg` / `jsonb_build_object` — when extending an endpoint, extend the existing aggregation rather than adding a second round-trip.
- File naming has known typos that are load-bearing (route filenames are `require`d literally): `services/iot/failtures.js`, WebSocket fields `suscribed*`. Don't rename without updating every `require` and client.
