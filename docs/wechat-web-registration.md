# WeChat-to-Web registration handoff

After a new WeChat identity activates, the API provisions a Supabase anonymous
user first and uses that user's UUID as the canonical TOMEET `user_id`. The
WeChat identity, conversation, memory, matchmaking state, and future Web login
therefore belong to the same account without moving data after registration.

The API does not send before the WeChat conversation is writable. The first
inbound iLink handshake claims one idempotent welcome package: four onboarding
bubbles followed by these three registration bubbles:

```text
想在网页上和别人线下加好友吗，有机会上TOMEET“必吃榜”！

这是微信里的同一个 TOMEET 账号，网页只用于注册和加好友；Agent 对话和发起匹配仍在微信

点这里为当前账号添加网页登录：https://tomeet.chat/register#claim=<one-time-token>
```

The plaintext claim is retained only as ciphertext so the authenticated worker
can recover the same link for that first handshake. The claim is random,
single-use, and valid for 15 minutes by default. It is
placed in the URL fragment so it is not sent in the initial HTTP request,
Vercel access logs, or referrer headers. Do not copy it into analytics,
`localStorage`, error reports, or server-rendered markup.

After every bubble is accepted by iLink, the API records the welcome as
delivered. User silence, worker restarts, and later QR scans never replay it.
If a delivery attempt is interrupted, retries reuse the same provider client
IDs for each bubble so already accepted bubbles remain idempotent.

## Registration page contract

The `/register` page reads `window.location.hash`, removes the claim from the
visible URL, and redeems it once:

```ts
const parameters = new URLSearchParams(window.location.hash.slice(1));
const token = parameters.get("claim");
history.replaceState(null, "", `${location.pathname}${location.search}`);

const response = await fetch("https://api.tomeet.chat/auth/wechat/claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token })
});
const result = await response.json();
if (!response.ok) throw new Error(result.message);

await supabase.auth.setSession({
  access_token: result.session.accessToken,
  refresh_token: result.session.refreshToken
});
```

At this point the browser is signed in as the same anonymous Supabase user that
owns the WeChat profile. The page should present these upgrade choices:

Use this primary explanation above the choices:

```text
这是你微信里的同一个 TOMEET 账号
网页用于账号资料、线下加好友和必吃榜；Agent 对话和发起匹配仍在微信
注册不会新建第二个用户，也不会重置微信里的画像或正在进行的匹配
```

### Email and password

```ts
await supabase.auth.updateUser({
  email,
  password,
  data: { registration_status: "complete", registration_method: "email_password" }
});
```

Honor the project's email-confirmation policy before treating the email as
verified.

### Phone and password

```ts
await supabase.auth.updateUser({
  phone,
  password,
  data: { registration_status: "complete", registration_method: "phone_password" }
});
```

Complete the Supabase phone-change OTP challenge before treating the phone as
verified.

### Google

```ts
await supabase.auth.linkIdentity({
  provider: "google",
  options: {
    redirectTo: `${window.location.origin}/api/auth/callback?next=/`
  }
});
```

Supabase manual identity linking must be enabled. After the OAuth callback,
update `registration_status` and redirect to the Web social home page.

## UX and conflict rules

- The page title is `为微信里的 TOMEET 添加网页登录`, not `创建另一个账号`.
- Explain that registration upgrades the existing WeChat user and keeps its
  conversation, profile, active match request, room, and matching history.
- Do not show Agent chat, start-match buttons, matching options, or matching
  controls on Web. Those product flows remain WeChat-only.
- The claim response includes `accountContinuity.mode=upgrade_existing_wechat_user`
  and `preserves=[conversation,profile,matching]`; render this as user-facing copy,
  not as technical account IDs.
- If the browser already has a different Supabase user, send its Bearer token when
  redeeming. The API returns `409 wechat_web_account_switch_required` without
  consuming the claim. Ask the user to confirm signing out, then retry without the
  old token. Never silently replace the current browser session.
- An invalid, consumed, or expired claim receives the same generic error. Tell
  the user to return to WeChat and request a fresh registration link.
- Never create a second `public.users` row during registration. Registration
  upgrades the anonymous `auth.users` row whose UUID was returned by the claim.
- Email, phone, and Google must be attached with `updateUser` or `linkIdentity`.
  Do not call a fresh sign-up/sign-in flow, because that would create or enter a
  different Supabase user and split the user's matching state.

## Runtime configuration

```text
WECHAT_WEB_REGISTRATION_URL=https://tomeet.chat/register
WECHAT_WEB_CLAIM_TTL_SECONDS=900
```

The Supabase project must have anonymous sign-ins enabled. The API uses
`WECHAT_CREDENTIAL_ENCRYPTION_KEY` to encrypt the temporary access and refresh
tokens at rest and deletes the claim row immediately after successful redemption.
