# xc-brain

VinCham 主脑架构（TypeScript）

## 模块

- `brain/` — 六层架构：基础/资源/知识/交互/智能/入口
- `di.ts` — DI 容器（ClawbotClient + Supabase 注入）
- `vin-cham.ts` — 主脑入口

## 构建

```bash
npm install
npm run build
```

## 分支

- `main` — 稳定版本
- `feat/*` — 功能开发
- `fix/*` — 缺陷修复

## 架构原则

- 1+5 原子：主脑 + 5 永久助手不可拆
- 工具挂载权归脑
- 客制小助手裸进会议（CUSTOM_NAKED）
- SkillsBank + ToolWarehouse 同走 MCP 管道
