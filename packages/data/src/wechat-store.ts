import type {
  ActivateWechatSessionInput,
  CreateWechatSessionInput,
  WechatConnection,
  WechatConnectionSession,
  WechatSessionUpdate
} from "@tomeet/wechat-ilink";

export interface WechatConnectionStore {
  createWechatSession(input: CreateWechatSessionInput): Promise<WechatConnectionSession>;
  getWechatSession(sessionId: string): Promise<WechatConnectionSession | null>;
  updateWechatSession(
    sessionId: string,
    update: WechatSessionUpdate,
    options?: {
      ifStatusIn?: WechatConnectionSession["status"][];
    }
  ): Promise<WechatConnectionSession>;
  activateWechatSession(input: ActivateWechatSessionInput): Promise<{
    session: WechatConnectionSession;
    connection: WechatConnection;
  }>;
  claimWechatConnections(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<WechatConnection[]>;
  renewWechatConnectionLease(
    connectionId: string,
    workerId: string,
    leaseSeconds: number
  ): Promise<boolean>;
  updateWechatConnectionCursor(
    connectionId: string,
    workerId: string,
    cursor: string,
    lastMessageAt?: string
  ): Promise<boolean>;
  releaseWechatConnection(connectionId: string, workerId: string): Promise<void>;
  markWechatConnectionError(input: {
    connectionId: string;
    workerId: string;
    message: string;
    reauthRequired: boolean;
  }): Promise<void>;
  beginWechatMessage(connectionId: string, messageId: string): Promise<boolean>;
  completeWechatMessage(
    connectionId: string,
    messageId: string,
    error?: string
  ): Promise<void>;
}
