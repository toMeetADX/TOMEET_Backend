# TOMEET WeChat local runtime

The WeChat channel uses a dedicated `agent-wechat` Linux container on port
`6174`. Photon/Spectrum polls that REST service and forwards inbound messages to
the existing TOMEET API.

Use a dedicated WeChat account. One container supports one logged-in account.
The first login and later reconnects may require scanning a QR code in the VNC
page.

## Local startup

On Windows, start Docker Desktop in Linux-container mode. This working copy has
a local-only launcher (excluded from Git), which can be run from the repository
root:

```powershell
.\dev-wechat.cmd
```

The launcher:

1. creates local secrets when missing without printing them;
2. starts the `agent-wechat` container;
3. opens the local VNC login page;
4. ensures the API has loaded the shared internal token;
5. starts `@tomeet/wechat-gateway` in the current terminal.

The launcher and generated secrets are excluded from Git.

For a fresh clone without that convenience launcher:

1. create a 32-byte hex token at
   `%USERPROFILE%\.config\agent-wechat\token`;
2. set `AGENT_WECHAT_TOKEN_FILE` to that absolute file path;
3. add the same random `TOMEET_INTERNAL_API_TOKEN` (at least 32 characters) to
   the API and gateway environments;
4. run `docker compose -f infra/wechat/docker-compose.yml up -d`;
5. open `http://localhost:6174/vnc/?token=<agent-wechat-token>` and scan the QR;
6. start the API, then run `pnpm dev:wechat`.

The local launcher enables `WECHAT_AUTO_PROVISION=true` for `DEMO_MODE=true`, so
the first message creates a deterministic temporary TOMEET profile and can reply
immediately. In Supabase/non-demo environments this option is ignored; the
WeChat identity must be linked to an existing account.

## Production notes

- Replace the floating container tag with a reviewed image digest before a
  production deployment.
- Keep `WECHAT_GROUPS=exclude` until group privacy behavior has been reviewed.
- Apply the Supabase migration before starting a non-demo API.
- `TOMEET_INTERNAL_API_TOKEN` must be identical for the API and gateway and must
  never be exposed to a browser client.
