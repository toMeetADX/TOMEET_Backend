import type { OfflineGame } from "@tomeet/contracts";

export const curatedGames: OfflineGame[] = [
  {
    id: "game-city-clues",
    name: "城市线索漫游",
    description: "小组沿路线完成观察、交换故事和轻量协作任务，适合第一次见面。",
    minPlayers: 4,
    maxPlayers: 8,
    intentTags: ["轻松认识", "城市探索", "自然交流"],
    traits: ["低压力", "有移动", "话题自然产生"],
    requirements: ["可步行约 60 分钟", "天气适宜"],
    instructions: ["抽取第一条城市线索", "两两寻找答案后交换搭档", "终点共同完成城市故事卡"]
  },
  {
    id: "game-story-table",
    name: "故事交换桌",
    description: "用图片卡和小问题逐步交换真实经历，适合偏安静或重视深度交流的人。",
    minPlayers: 3,
    maxPlayers: 6,
    intentTags: ["深度交流", "安静", "建立连接"],
    traits: ["室内", "节奏稳定", "表达友好"],
    requirements: ["安静桌面空间", "约 75 分钟"],
    instructions: ["每人选择一张近况卡", "轮流讲述并由下一位追问", "共同完成连接地图"]
  },
  {
    id: "game-coop-kitchen",
    name: "不看菜谱合作厨房",
    description: "成员分工完成一道简单料理，通过协作快速熟悉彼此。",
    minPlayers: 5,
    maxPlayers: 10,
    intentTags: ["活跃", "团队协作", "快速破冰"],
    traits: ["高互动", "有共同成果", "适合多人"],
    requirements: ["可用厨房", "提前确认过敏信息"],
    instructions: ["领取角色和食材线索", "通过交流拼出步骤", "完成后一起用餐复盘"]
  }
];

export function gamesSupportingPlayerCount(games: OfflineGame[], playerCount: number): OfflineGame[] {
  return games.filter((game) => game.minPlayers <= playerCount && game.maxPlayers >= playerCount);
}
