import type { PostEventFeedback, UserModel } from "@tomeet/contracts";

interface FeedbackModelInsight {
  currentIntent: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeLongTermProfile(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "interests" && Array.isArray(value)) {
      const previous = Array.isArray(merged.interests)
        ? merged.interests.filter((item): item is string => typeof item === "string")
        : [];
      const incoming = value.filter((item): item is string => typeof item === "string");
      merged.interests = [...new Set([...previous, ...incoming])].slice(-20);
    } else if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeLongTermProfile(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function createDefaultUserModel(userId: string): UserModel {
  return {
    userId,
    vibeNarrative: "",
    longTermProfile: { interests: [], interactionStyle: "待了解" },
    currentIntent: {},
    socialHistory: [],
    feedbackMemory: [],
    multimodalUnderstanding: {},
    version: 0,
    updatedAt: new Date().toISOString()
  };
}

export function applyConversationInsight(
  model: UserModel,
  insight: {
    interests?: string[];
    vibeNarrative?: string;
    longTermProfilePatch?: Record<string, unknown>;
    currentIntent?: Record<string, unknown>;
  }
): UserModel {
  return {
    ...model,
    currentIntent: insight.currentIntent
      ? structuredClone(insight.currentIntent)
      : model.currentIntent,
    version: model.version + 1,
    updatedAt: new Date().toISOString()
  };
}

export function applyMultimodalInsight(
  model: UserModel,
  inputId: string,
  insight: Record<string, unknown>
): UserModel {
  const safeInsight = { ...insight };
  delete safeInsight.longTermProfilePatch;
  delete safeInsight.vibeNarrative;
  const boundedUnderstanding = Object.fromEntries([
    ...Object.entries(model.multimodalUnderstanding),
    [inputId, safeInsight]
  ].slice(-20));
  return {
    ...model,
    multimodalUnderstanding: boundedUnderstanding,
    version: model.version + 1,
    updatedAt: new Date().toISOString()
  };
}

export function applyPostEventFeedback(
  model: UserModel,
  feedback: PostEventFeedback,
  insight?: FeedbackModelInsight
): UserModel {
  const memory = `人群：${feedback.peopleFeedback}；游戏：${feedback.gameFeedback}；下次：${feedback.nextIntent}`;
  const socialHistory = model.socialHistory.includes(feedback.roomId)
    ? model.socialHistory
    : [...model.socialHistory, feedback.roomId].slice(-50);
  return {
    ...model,
    currentIntent: insight?.currentIntent ?? { nextIntent: feedback.nextIntent },
    socialHistory,
    feedbackMemory: [...model.feedbackMemory, memory].slice(-50),
    version: model.version + 1,
    updatedAt: new Date().toISOString()
  };
}
