"use client";

import { QRCodeCanvas } from "qrcode.react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "./wechat.module.css";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type ConnectStatus =
  | "pending"
  | "scanned"
  | "verification_required"
  | "active"
  | "expired"
  | "failed";

interface ConnectSession {
  sessionId: string;
  sessionToken: string;
  qrCodeContent: string;
  status: ConnectStatus;
  expiresAt: string;
  confirmedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface StatusResponse {
  sessionId: string;
  status: ConnectStatus;
  expiresAt: string;
  confirmedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface ErrorBody {
  message?: string;
}

function statusCopy(status: ConnectStatus): string {
  switch (status) {
    case "pending":
      return "请使用微信扫描二维码";
    case "scanned":
      return "已扫码，请在微信中确认";
    case "verification_required":
      return "微信需要安全验证";
    case "active":
      return "连接成功，现在可以直接在微信中对话";
    case "expired":
      return "二维码已过期";
    case "failed":
      return "连接未完成";
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ErrorBody;
  if (!response.ok) throw new Error(body.message ?? `请求失败 (${response.status})`);
  return body;
}

export default function WechatConnectPage() {
  const [session, setSession] = useState<ConnectSession | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeSessionId = session?.sessionId;
  const activeSessionToken = session?.sessionToken;
  const activeSessionStatus = session?.status;

  const updateStatus = useCallback((status: StatusResponse) => {
    setSession((current) => current ? { ...current, ...status } : current);
  }, []);

  useEffect(() => {
    if (
      !activeSessionId
      || !activeSessionToken
      || activeSessionStatus === "active"
      || activeSessionStatus === "expired"
      || activeSessionStatus === "failed"
    ) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `${API_BASE}/wechat/connect/sessions/${encodeURIComponent(activeSessionId)}`,
          {
            headers: { "x-wechat-session-token": activeSessionToken },
            cache: "no-store",
            signal: controller.signal
          }
        );
        updateStatus(await readResponse<StatusResponse>(response));
        timer = setTimeout(poll, 800);
      } catch (pollError) {
        if (controller.signal.aborted) return;
        setError(pollError instanceof Error ? pollError.message : "状态检查失败");
        timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activeSessionId, activeSessionStatus, activeSessionToken, updateStatus]);

  async function startConnection() {
    setBusy(true);
    setError("");
    setVerifyCode("");
    try {
      const response = await fetch(`${API_BASE}/wechat/connect/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      setSession(await readResponse<ConnectSession>(response));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "二维码生成失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitVerification(event: FormEvent) {
    event.preventDefault();
    if (!session || !/^\d{4,12}$/.test(verifyCode)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${API_BASE}/wechat/connect/sessions/${encodeURIComponent(session.sessionId)}/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-wechat-session-token": session.sessionToken
          },
          body: JSON.stringify({ code: verifyCode })
        }
      );
      updateStatus(await readResponse<StatusResponse>(response));
      setVerifyCode("");
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "验证码提交失败");
    } finally {
      setBusy(false);
    }
  }

  const terminal = session?.status === "expired" || session?.status === "failed";

  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <div className={styles.brand}>T</div>
        <p className={styles.eyebrow}>TOMEET × 微信</p>
        <h1>把专属 Agent 带进微信</h1>
        <p className={styles.intro}>
          只需扫码一次。系统会自动创建或关联你的 profile，之后直接在微信中和 Agent 对话。
        </p>

        {!session ? (
          <button
            className={styles.primary}
            disabled={busy}
            onClick={() => void startConnection()}
            type="button"
          >
            {busy ? "正在生成…" : "生成一次性二维码"}
          </button>
        ) : (
          <div className={styles.connectArea}>
            {session.status !== "active" && !terminal && (
              <div className={styles.qrFrame}>
                <QRCodeCanvas
                  bgColor="#ffffff"
                  fgColor="#16382a"
                  includeMargin
                  level="M"
                  size={232}
                  value={session.qrCodeContent}
                />
              </div>
            )}

            <div className={`${styles.status} ${styles[session.status]}`}>
              <span aria-hidden="true" />
              {statusCopy(session.status)}
            </div>

            {session.status === "verification_required" && (
              <form className={styles.verifyForm} onSubmit={submitVerification}>
                <label htmlFor="wechat-code">微信验证码</label>
                <div>
                  <input
                    autoComplete="one-time-code"
                    id="wechat-code"
                    inputMode="numeric"
                    maxLength={12}
                    onChange={(event) => setVerifyCode(event.target.value.replace(/\D/g, ""))}
                    placeholder="输入微信显示的数字"
                    value={verifyCode}
                  />
                  <button
                    className={styles.secondary}
                    disabled={busy || !/^\d{4,12}$/.test(verifyCode)}
                    type="submit"
                  >
                    验证
                  </button>
                </div>
              </form>
            )}

            {session.status === "active" && (
              <div className={styles.successPanel}>
                <strong>连接已保存</strong>
                <p>回到微信，向刚刚连接的 Agent 发送一条文字消息即可开始。</p>
              </div>
            )}

            {terminal && (
              <>
                <p className={styles.sessionError}>
                  {session.errorMessage ?? "请重新生成二维码后再试。"}
                </p>
                <button
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => void startConnection()}
                  type="button"
                >
                  重新生成
                </button>
              </>
            )}
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <ol className={styles.steps}>
          <li><span>1</span>微信扫码并确认</li>
          <li><span>2</span>自动建立专属 Agent</li>
          <li><span>3</span>以后只在微信中聊天</li>
        </ol>
        <p className={styles.security}>二维码和会话凭证不会保存在浏览器本地。</p>
      </section>
    </main>
  );
}
