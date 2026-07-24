# WeChat QR API handoff

Production API base URL:

```text
https://api.tomeet.chat
```

The browser integration uses three public endpoints. The QR payload and session
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

## 2. Poll the session

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

Poll every 800–1500 ms while the status is non-terminal. Stop polling after
`active`, `expired`, or `failed`.

## 3. Submit a WeChat verification code

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
2. Render `qrCodeContent` and begin polling.
3. For an untouched `pending` session, create a replacement 30 seconds before
   `expiresAt`.
4. Do not replace the QR while the status is `scanned` or
   `verification_required`.
5. After `active`, briefly show success and then create a fresh session for the
   next visitor.
6. Abort polling and discard the in-memory token when the component unmounts.

The production browser origin currently allowed by CORS is:

```text
https://tomeet.chat
```
