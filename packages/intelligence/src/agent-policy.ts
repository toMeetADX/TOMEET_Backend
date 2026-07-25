import type { AgentAction } from "@tomeet/agent-core";
import type {
  AgentProductEventKind,
  Message,
  SocialHookDraft
} from "@tomeet/contracts";
import { StoreConflictError } from "@tomeet/data";

/** Active transaction with the user vs cold outreach that requires push consent. */
export type OutboundDeliveryClass = "active_flow" | "proactive_recall";

const MULTIMODAL_PLACEHOLDER = /^(?:\[发送了一张图片\]|\[一次发送了\s*\d+\s*张图片\]|\[发送了一段录音\])/u;

/** Legacy-only: V1 accepts candidates as confirmed membership. */
export const V1_FORBIDDEN_ACTIONS = new Set<AgentAction["type"]>(["confirm_room"]);

/** Actions that only exist on the AdventureX clearing-tick path. */
export const V1_ONLY_ACTIONS = new Set<AgentAction["type"]>([
  "select_match_options",
  "refresh_match_options",
  "explain_match_option",
  "enable_match_push",
  "disable_match_push",
  "activate_match"
]);

export function isMultimodalPlaceholderContent(content: string): boolean {
  return MULTIMODAL_PLACEHOLDER.test(content.trim());
}

export function isUserTextEvidenceMessage(message: Pick<Message, "role" | "content">): boolean {
  return message.role === "user" && !isMultimodalPlaceholderContent(message.content);
}

/** Social hooks must bind to user-confirmed text, never image/audio placeholders. */
export function filterSocialHooksByTextEvidence(
  hooks: SocialHookDraft[],
  messages: Array<Pick<Message, "id" | "role" | "content">>
): SocialHookDraft[] {
  const textEvidenceIds = new Set(
    messages.filter(isUserTextEvidenceMessage).map((message) => message.id)
  );
  return hooks.filter((hook) =>
    hook.evidenceMessageIds.length > 0
    && hook.evidenceMessageIds.every((messageId) => textEvidenceIds.has(messageId))
  );
}

export function assertActionMatchesMatchingFlag(
  action: AgentAction,
  adventurexMatchingV1: boolean
): void {
  if (adventurexMatchingV1 && V1_FORBIDDEN_ACTIONS.has(action.type)) {
    throw new StoreConflictError(`AdventureX V1 不支持动作 ${action.type}`);
  }
  if (!adventurexMatchingV1 && V1_ONLY_ACTIONS.has(action.type)) {
    throw new StoreConflictError(`未开启 AdventureX V1 时不支持动作 ${action.type}`);
  }
}

export function defaultDeliveryClassForEvent(kind: AgentProductEventKind): OutboundDeliveryClass {
  switch (kind) {
    case "match_options":
    case "match_unavailable":
      // Call sites should override for watching recall; default is active attempt.
      return "active_flow";
    case "match_option_detail":
    case "action_failed":
    case "match_confirmation_incomplete":
    case "room_intro":
    case "match_expired":
    case "room_change":
    case "draft_change":
    case "legacy_match_ready":
    case "unsupported_channel_message":
    case "channel_media_unreadable":
      return "active_flow";
  }
}

export function actionFailureCode(error: unknown): string {
  if (error instanceof Error) {
    if (/不存在|没有/.test(error.message)) return "not_found";
    if (/已经|冲突|变化|失效/.test(error.message)) return "conflict";
  }
  return "failed";
}
