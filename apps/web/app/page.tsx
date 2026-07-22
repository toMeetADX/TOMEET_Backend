"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface Job {
  id: string;
  status: "pending" | "processing" | "completed" | "retry" | "failed";
  error?: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? `请求失败：${response.status}`);
  return body;
}

async function waitForJob(initialJob: Job): Promise<Job> {
  if (initialJob.status === "completed" || initialJob.status === "failed") return initialJob;
  for (let index = 0; index < 60; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { job } = await api<{ job: Job }>(`/jobs/${initialJob.id}`);
    if (job.status === "completed" || job.status === "failed") return job;
  }
  throw new Error("Agent 暂时还没有回复，请稍后再试。");
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

export default function ChatPage() {
  const [userId, setUserId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  async function refreshMessages(id = userId) {
    if (!id) return;
    const response = await api<{ messages: ChatMessage[] }>(`/agent/messages/${id}`);
    setMessages(response.messages);
  }

  useEffect(() => {
    const stored = localStorage.getItem("tomeet-chat-user-id");
    const id = stored ?? crypto.randomUUID();
    localStorage.setItem("tomeet-chat-user-id", id);
    setUserId(id);
    refreshMessages(id).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!userId) return;
    const timer = window.setInterval(() => refreshMessages().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !userId || sending) return;

    setDraft("");
    setError("");
    setSending(true);
    const optimistic: ChatMessage = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, optimistic]);

    try {
      const response = await api<{ job: Job }>("/agent/messages", {
        method: "POST",
        body: JSON.stringify({
          userId,
          displayName: "测试用户",
          content,
          idempotencyKey: crypto.randomUUID()
        })
      });
      const job = await waitForJob(response.job);
      if (job.status === "failed") throw new Error(job.error || "Agent 处理失败");
      await refreshMessages();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refreshMessages().catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  async function sendImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !userId || sending) return;
    if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) {
      setError("请选择 JPG、PNG 或 WebP 图片");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("图片不能超过 10MB");
      return;
    }

    const hint = draft.trim();
    setDraft("");
    setError("");
    setSending(true);
    setMessages((current) => [...current, {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: `[图片] ${file.name}${hint ? `\n${hint}` : ""}`,
      createdAt: new Date().toISOString()
    }]);

    try {
      const uploaded = await api<{ storagePath: string; mimeType: string; sizeBytes: number }>("/uploads", {
        method: "POST",
        body: JSON.stringify({
          userId,
          fileName: file.name,
          mimeType: file.type,
          dataUrl: await readAsDataUrl(file)
        })
      });
      const response = await api<{ job: Job }>("/agent/multimodal-inputs", {
        method: "POST",
        body: JSON.stringify({
          userId,
          kind: "image",
          storagePath: uploaded.storagePath,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          hint: hint || undefined
        })
      });
      const job = await waitForJob(response.job);
      if (job.status === "failed") throw new Error(job.error || "图片理解失败");
      await refreshMessages();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refreshMessages().catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <main className="chatShell">
      <header className="chatHeader">
        <div className="avatar">T</div>
        <div>
          <h1>TOMEET</h1>
          <p><span /> 正在认识你</p>
        </div>
      </header>

      <section className="messageList" aria-live="polite">
        {messages.length === 0 && (
          <div className="message assistant welcome">
            <div className="bubble">
              嗨，我是 TOMEET。你可以从最近的状态、喜欢的事情开始，也可以直接告诉我你现在想认识怎样的人。
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            <div className="bubble">{message.content}</div>
          </div>
        ))}

        {sending && (
          <div className="message assistant">
            <div className="bubble typing"><i /><i /><i /></div>
          </div>
        )}

        {error && <div className="errorMessage">{error}</div>}
        <div ref={bottomRef} />
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <input
          accept="image/jpeg,image/png,image/webp"
          className="imageInput"
          onChange={sendImage}
          ref={imageInputRef}
          type="file"
        />
        <button
          aria-label="添加图片"
          className="imageButton"
          disabled={sending || !userId}
          onClick={() => imageInputRef.current?.click()}
          type="button"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="2" />
            <path d="m4 17 4.5-4 3.5 3 3-3 5 4" />
          </svg>
        </button>
        <textarea
          aria-label="发消息给 TOMEET"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="和 TOMEET 说点什么…"
          rows={1}
          value={draft}
        />
        <button aria-label="发送" disabled={!draft.trim() || sending || !userId} type="submit">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4.5 14-3-6.5L5 12Zm0 0h6.5" /></svg>
        </button>
      </form>
    </main>
  );
}
