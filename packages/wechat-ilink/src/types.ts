export type WechatQrProtocolStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export type WechatConnectionSessionStatus =
  | "pending"
  | "scanned"
  | "verification_required"
  | "active"
  | "expired"
  | "failed";

export type WechatConnectionStatus =
  | "active"
  | "reauth_required"
  | "disconnected"
  | "revoked"
  | "error";

export interface WechatQrStart {
  qrCode: string;
  qrCodeContent: string;
}

export interface WechatQrStatus {
  status: WechatQrProtocolStatus;
  botToken?: string;
  ilinkBotId?: string;
  baseUrl?: string;
  ilinkUserId?: string;
  redirectHost?: string;
}

export interface WechatMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: {
    media?: WechatCdnMedia;
    thumb_media?: WechatCdnMedia;
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
  };
  voice_item?: { text?: string; media?: WechatCdnMedia };
}

export interface WechatCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface WechatInboundMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface WechatUpdates {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  // Local transport metadata. This field is never sent to or expected from iLink.
  transport_timed_out?: boolean;
}

export interface WechatConnectionSession {
  id: string;
  sessionTokenHash: string;
  qrTokenCiphertext: string;
  status: WechatConnectionSessionStatus;
  pollBaseUrl: string;
  requestedUserId: string | null;
  connectionId: string | null;
  userId: string | null;
  expiresAt: string;
  confirmedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WechatConnection {
  id: string;
  userId: string;
  ilinkBotId: string;
  ownerIlinkUserId: string;
  botTokenCiphertext: string;
  baseUrl: string;
  syncCursor: string;
  status: WechatConnectionStatus;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WechatOutboundDelivery {
  id: string;
  messageId: string;
  userId: string;
  content: string;
  kind: "message" | "onboarding_welcome";
  claimId: string | null;
  attempts: number;
  connection: WechatConnection;
}

export interface WechatWebClaim {
  id: string;
  userId: string;
  tokenHash: string;
  tokenCiphertext: string | null;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  exposedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface CreateWechatWebClaimInput {
  id: string;
  userId: string;
  tokenHash: string;
  tokenCiphertext: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
}

export interface ActivateWechatSessionInput {
  sessionId: string;
  newUserId: string;
  ownerIlinkUserId: string;
  ilinkBotId: string;
  botTokenCiphertext: string;
  baseUrl: string;
}

export interface CreateWechatSessionInput {
  id: string;
  sessionTokenHash: string;
  qrTokenCiphertext: string;
  pollBaseUrl: string;
  expiresAt: string;
  requestedUserId?: string;
}

export interface WechatSessionUpdate {
  status?: WechatConnectionSessionStatus;
  pollBaseUrl?: string;
  connectionId?: string | null;
  userId?: string | null;
  confirmedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}
