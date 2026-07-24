# WeChat QR API handoff

Production API base URL:

```text
https://api.tomeet.chat
```

The browser integration uses four public endpoints. The QR payload and session
token must be treated as temporary credentials and must not be stored in
`localStorage`, analytics events, or application logs.

## 1. Create a QR session

```http
POST /wechat/connect/sessions
Content-Type: application/json

{}
```

Successful response: `201 Created`

```json
{
  "sessionId": "uuid",
  "sessionToken": "temporary-secret",
  "qrCodeContent": "content-to-render-as-a-qr-code",
  "status": "pending",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "confirmedAt": null,
  "errorCode": null,
  "errorMessage": null
}
```

Render `qrCodeContent` as a QR code. Keep `sessionToken` in memory for the
current page only.

The production limit is 30 create requests per 10 minutes per client. On
`429 Too Many Requests`, wait for the `Retry-After` response header before
trying again.

## 2. Stream session changes with SSE

```http
GET /wechat/connect/sessions/{sessionId}/events
Accept: text/event-stream
X-WeChat-Session-Token: {sessionToken}
```

The server immediately emits the current state and then pushes every state
change as a `session` event. It sends heartbeat comments while the upstream
WeChat long poll is waiting and closes the stream after `active`, `expired`, or
`failed`.

```text
event: session
data: {"sessionId":"uuid","status":"scanned",...}

event: done
data: {"sessionId":"uuid","status":"active",...}
```

Use `fetch()` plus `ReadableStream` so the session token remains in the request
header. Do not put the token in the query string to use the native
`EventSource` constructor.

## 3. Get the current state (fallback)

```http
GET /wechat/connect/sessions/{sessionId}
X-WeChat-Session-Token: {sessionToken}
```

Successful response: `200 OK`

```json
{
  "sessionId": "uuid",
  "status": "pending",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "confirmedAt": null,
  "errorCode": null,
  "errorMessage": null
}
```

Possible status values:

- `pending`: waiting for a scan
- `scanned`: scanned; waiting for confirmation in WeChat
- `verification_required`: show the verification-code form
- `active`: connection completed
- `expired`: create a new session
- `failed`: show the error and create a new session when appropriate

Use this endpoint as a fallback when the SSE stream cannot be established.
Retry SSE after a short backoff and stop after `active`, `expired`, or `failed`.

## 4. Submit a WeChat verification code

Only call this endpoint after receiving `verification_required`.

```http
POST /wechat/connect/sessions/{sessionId}/verify
Content-Type: application/json
X-WeChat-Session-Token: {sessionToken}

{
  "code": "123456"
}
```

The code must contain 4–12 digits. The response has the same shape as the poll
response.

## Recommended landing-page lifecycle

1. Create a session when the QR module becomes visible.
2. Render `qrCodeContent` and open the SSE stream.
3. For an untouched `pending` session, create a replacement 30 seconds before
   `expiresAt`.
4. When the displayed session becomes `scanned`, immediately mask that QR,
   retain and monitor the claimed session, and create a fresh displayed QR for
   the next visitor.
5. Keep every claimed session in memory until it becomes `active`, `expired`,
   or `failed`. A claimed session that fails must tell that visitor to scan the
   fresh QR again.
6. If a claimed session enters `verification_required`, submit the code against
   that original session rather than the newly displayed session.
7. Abort all SSE streams and discard all in-memory tokens when the component
   unmounts.

The production browser origin currently allowed by CORS is:

```text
https://tomeet.chat
```
