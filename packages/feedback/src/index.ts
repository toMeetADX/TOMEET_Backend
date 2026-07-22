import type { PostEventFeedback, UserModel } from "@tomeet/contracts";

interface FeedbackModelInsight {
  memory: string;
  vibeNarrative?: string;
  longTermProfilePatch: Record<string, unknown>;
  currentIntent: Record<string, unknown>;
}
import { applyPostEventFeedback } from "@tomeet/user-model";

export function updateModelFromFeedback(
  model: UserModel,
  feedback: PostEventFeedback,
  insight?: FeedbackModelInsight
): UserModel {
  return applyPostEventFeedback(model, feedback, insight);
}
