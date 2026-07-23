import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const VERSION = "v1";

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[a-fA-F0-9]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "WECHAT_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64 hex characters"
    );
  }
  return key;
}

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = decodeKey(encodedKey);
  }

  encrypt(plaintext: string, context: string): string {
    if (!plaintext) throw new Error("Cannot encrypt an empty credential");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  decrypt(payload: string, context: string): string {
    const [version, ivValue, tagValue, encryptedValue, extra] = payload.split(".");
    if (
      version !== VERSION
      || !ivValue
      || !tagValue
      || !encryptedValue
      || extra !== undefined
    ) {
      throw new Error("Unsupported encrypted credential");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSessionToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
