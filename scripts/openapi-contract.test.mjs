import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("OpenAPI documents the complete browser-facing WeChat QR contract", async () => {
  const source = await readFile(
    new URL("../docs/openapi.yaml", import.meta.url),
    "utf8"
  );
  const document = parse(source);
  assert.equal(document.openapi, "3.1.0");

  const create = document.paths?.["/wechat/connect/sessions"]?.post;
  const status = document.paths?.["/wechat/connect/sessions/{sessionId}"]?.get;
  const events = document.paths?.["/wechat/connect/sessions/{sessionId}/events"]?.get;
  const verify = document.paths?.["/wechat/connect/sessions/{sessionId}/verify"]?.post;
  assert.ok(create);
  assert.ok(status);
  assert.ok(events);
  assert.ok(verify);

  assert.deepEqual(create.security, [{}, { bearerAuth: [] }]);
  assert.deepEqual(status.security, [{ wechatSessionToken: [] }]);
  assert.deepEqual(events.security, [{ wechatSessionToken: [] }]);
  assert.deepEqual(verify.security, [{ wechatSessionToken: [] }]);
  assert.equal(
    document.components.securitySchemes.wechatSessionToken.name,
    "X-WeChat-Session-Token"
  );
  assert.equal(
    events.responses["200"].content["text/event-stream"].schema.type,
    "string"
  );

  assert.deepEqual(
    document.components.schemas.WechatQrSessionStatus.enum,
    [
      "pending",
      "scanned",
      "verification_required",
      "active",
      "expired",
      "failed"
    ]
  );
  assert.equal(
    document.components.schemas.WechatVerificationCodeInput.properties.code.pattern,
    "^\\d{4,12}$"
  );

  const publicProperties = Object.keys(
    document.components.schemas.WechatQrSession.properties
  );
  for (const secret of [
    "sessionToken",
    "qrCodeContent",
    "botToken",
    "sessionTokenHash",
    "qrTokenCiphertext"
  ]) {
    assert.ok(!publicProperties.includes(secret));
  }
  const creationProperties = Object.keys(
    document.components.schemas.WechatQrSessionCreated.properties
  );
  assert.ok(creationProperties.includes("sessionToken"));
  assert.ok(creationProperties.includes("qrCodeContent"));
});
