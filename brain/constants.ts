// ⚠️ 焊死 — 任何人不得修改 PERMANENT_ASSISTANTS 列表
// 修改须经 OpenMaic 会议室决议，不存在绕过路径

export const PERMANENT_ASSISTANTS = [
  'duck-lee',   // 李黑鸭 Duck Lee
  'sparky',    // 斯巴达 Sparky
  'wu-tian',    // 武天 WuTian
  'feifei',     // 狒狒 Feifei
  'forty-cents',     // 四毛 Forty Cents
] as const;

export type PermanentId = typeof PERMANENT_ASSISTANTS[number];

export const BRAIN_ID = 'vin-cham' as const;
export const BRAIN_NAME = '文成大圣' as const;

// 标准工具包 — 每个助手预挂，主脑分配，可回收
export const STANDARD_TOOLKIT = [
  'std.browser',    // 浏览器
  'std.folder',     // 文件夹
  'std.terminal',   // 终端
  'std.text',       // 文本文件处理包
] as const;

export type StandardTool = typeof STANDARD_TOOLKIT[number];

// 会议室守卫
export const MEETING_ROLES = {
  MODERATOR: 'moderator',       // 文成大圣，永久主持
  PERMANENT: 'permanent',       // 5 个永久助手，带标准工具包
  CUSTOM_NAKED: 'custom_naked', // 客制小助手，裸进，只有发言权
} as const;
