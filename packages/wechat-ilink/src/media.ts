import { createDecipheriv } from "node:crypto";
import type { WechatMessageItem } from "./types.js";

export const DEFAULT_WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface DownloadedWechatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

function safeCdnUrl(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  fullUrl?: string
): URL {
  const base = new URL(cdnBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("微信 CDN 地址必须使用无凭证 HTTPS URL");
  }
  const target = fullUrl
    ? new URL(fullUrl)
    : new URL(`download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`, `${base.toString().replace(/\/$/u, "")}/`);
  const hostAllowed = target.hostname === base.hostname
    || target.hostname.endsWith(".cdn.weixin.qq.com");
  if (
    target.protocol !== "https:"
    || target.username
    || target.password
    || !hostAllowed
  ) {
    throw new Error("微信图片 CDN 返回了不安全的下载地址");
  }
  return target;
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/iu.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("微信图片 AES key 格式无效");
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectImageMime(bytes: Uint8Array): DownloadedWechatImage["mimeType"] {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  throw new Error("微信图片格式不是 JPEG、PNG 或 WebP");
}

export async function downloadWechatImage(
  item: WechatMessageItem,
  options: {
    cdnBaseUrl?: string;
    fetch?: typeof globalThis.fetch;
    maxBytes?: number;
    timeoutMs?: number;
  } = {}
): Promise<DownloadedWechatImage> {
  if (item.type !== 2 || !item.image_item) {
    throw new Error("微信消息不包含可下载图片");
  }
  const image = item.image_item;
  const media = [image.media, image.thumb_media].find((candidate) => (
    candidate?.encrypt_query_param || candidate?.full_url
  ));
  const fullUrl = media?.full_url ?? image.url;
  if (!media?.encrypt_query_param && !fullUrl) {
    throw new Error("微信图片缺少 CDN 下载参数");
  }
  const url = safeCdnUrl(
    media?.encrypt_query_param ?? "",
    options.cdnBaseUrl ?? DEFAULT_WECHAT_CDN_BASE_URL,
    fullUrl
  );
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
  });
  if (!response.ok) throw new Error(`微信图片下载失败 (${response.status})`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error("微信图片超过大小限制");
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (encrypted.length === 0 || encrypted.length > maxBytes + 16) {
    throw new Error("微信图片为空或超过大小限制");
  }
  const aesKeyBase64 = media?.aes_key
    ?? (image.aeskey ? Buffer.from(image.aeskey, "hex").toString("base64") : undefined);
  const plaintext = aesKeyBase64
    ? decryptAesEcb(encrypted, parseAesKey(aesKeyBase64))
    : encrypted;
  if (plaintext.length === 0 || plaintext.length > maxBytes) {
    throw new Error("微信图片解密结果为空或超过大小限制");
  }
  return {
    bytes: Uint8Array.from(plaintext),
    mimeType: detectImageMime(plaintext)
  };
}
