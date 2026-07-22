import { describe, expect, it } from "vitest";
import { curatedGames } from "@tomeet/game-catalog";
import { validateMatchDecision } from "./index.js";

describe("match decision validation", () => {
  it("rejects duplicated members", () => {
    expect(() => validateMatchDecision({
      memberIds: ["u1", "u1", "u3"],
      requestIds: ["r1", "r2", "r3"],
      offlineGameId: "game-story-table",
      summary: "test"
    }, [], curatedGames[1])).toThrow("不能重复");
  });
});
