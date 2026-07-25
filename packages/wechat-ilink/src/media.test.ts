import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadWechatImage } from "./media.js";

function encrypt(bytes: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

describe("downloadWechatImage", () => {
  it("downloads and decrypts an inbound JPEG", async () => {
    const key = randomBytes(16);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("image-data")]);
    const encrypted = encrypt(jpeg, key);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => (
      new Response(Uint8Array.from(encrypted))
    ));

    await expect(downloadWechatImage({
      type: 2,
      image_item: {
        aeskey: key.toString("hex"),
        media: { encrypt_query_param: "encrypted-param" }
      }
    }, { fetch: fetchMock })).resolves.toEqual({
      bytes: Uint8Array.from(jpeg),
      mimeType: "image/jpeg"
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("encrypted_query_param=encrypted-param");
  });

  it("accepts a base64 media key and rejects untrusted full URLs", async () => {
    const key = randomBytes(16);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("image-data")
    ]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => (
      new Response(Uint8Array.from(encrypt(png, key)))
    ));

    await expect(downloadWechatImage({
      type: 2,
      image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image", aes_key: key.toString("base64") } }
    }, { fetch: fetchMock })).resolves.toMatchObject({ mimeType: "image/png" });

    await expect(downloadWechatImage({
      type: 2,
      image_item: { media: { full_url: "https://example.com/private-image" } }
    })).rejects.toThrow("不安全");
  });

  it("falls back to the thumbnail media when the full-size payload is missing", async () => {
    const key = randomBytes(16);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("thumb")]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => (
      new Response(Uint8Array.from(encrypt(jpeg, key)))
    ));

    await expect(downloadWechatImage({
      type: 2,
      image_item: {
        media: {},
        thumb_media: { encrypt_query_param: "thumb-param", aes_key: key.toString("base64") }
      }
    }, { fetch: fetchMock })).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("encrypted_query_param=thumb-param");
  });

  it("reports a picture without any download source instead of silently dropping it", async () => {
    await expect(downloadWechatImage({
      type: 2,
      image_item: { media: {} }
    })).rejects.toThrow("CDN 下载参数");
  });
});
