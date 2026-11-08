/**
 * skills-bank.ts
 *
 * SkillsBank — MCP skills 注册表 + 挂载查询层
 *
 * 职责：
 *  1. 维护 skills 注册表（Map<skillId, Skill>）
 *  2. 提供 search/discover API，供主脑在会议后查询合适 skills
 *  3. mount/unmount 记录哪个助手当前挂载了哪些 skill
 *  4. 所有 skills 通过 MCP 协议暴露（mcpTool 字段）
 */

import type { Skill, SkillMount } from './types.js';
import type { PermanentId } from './constants.js';

// ─────────────────────────────────────────────────────────────
// Search query interface
// ─────────────────────────────────────────────────────────────

export interface SkillSearchQuery {
  tags?: string[];
  category?: string;
  text?: string;
}

// ─────────────────────────────────────────────────────────────
// SkillsBank
// ─────────────────────────────────────────────────────────────

export class SkillsBank {
  /** skill id → Skill */
  private readonly registry = new Map<string, Skill>();

  /**
   * assistantId → list of SkillMount
   * 每次 mount/unmount 操作维护此表
   */
  private readonly mounts = new Map<PermanentId, SkillMount[]>();

  constructor() {
    this.registerBuiltins();
  }

  // ── 注册 ─────────────────────────────────────────────────

  /**
   * 注册一个 skill（启动时或运行时动态注册）。
   * 重复 id 时静默覆盖（新版本替换旧版本）。
   */
  register(skill: Skill): void {
    this.registry.set(skill.id, skill);
  }

  // ── 查询 ─────────────────────────────────────────────────

  /**
   * 主脑读取会议行动清单后，搜索需要挂哪些 skills。
   * 三个条件做 AND 过滤；全空查询返回全量。
   */
  search(query: SkillSearchQuery): Skill[] {
    const { tags, category, text } = query;
    const needle = text?.toLowerCase();

    return Array.from(this.registry.values()).filter((skill) => {
      // category 过滤
      if (category && skill.category !== category) return false;

      // tags 过滤：查询 tags 是 skill.tags 的子集
      if (tags && tags.length > 0) {
        const skillTagSet = new Set(skill.tags);
        if (!tags.every((t) => skillTagSet.has(t))) return false;
      }

      // 全文过滤：匹配 name / description / id
      if (needle) {
        const haystack =
          `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      return true;
    });
  }

  // ── 挂载管理 ─────────────────────────────────────────────

  /**
   * 为助手挂载一个 skill（记录 SkillMount）。
   * 若 skill 不存在则抛出 Error。
   * 同一助手对同一 skill 幂等（不重复插入）。
   */
  mount(assistantId: PermanentId, skillId: string, meetingId?: string): void {
    if (!this.registry.has(skillId)) {
      throw new Error(`SkillsBank: skill "${skillId}" not found`);
    }

    const existing = this.mounts.get(assistantId) ?? [];

    // 幂等检查
    if (existing.some((m) => m.skillId === skillId)) return;

    const entry: SkillMount = {
      skillId,
      assistantId,
      mountedAt: new Date(),
      ...(meetingId ? { meetingId } : {}),
    };

    this.mounts.set(assistantId, [...existing, entry]);
  }

  /**
   * 收回助手的一个 skill 挂载。
   * 若该挂载不存在则静默忽略。
   */
  unmount(assistantId: PermanentId, skillId: string): void {
    const existing = this.mounts.get(assistantId);
    if (!existing) return;

    const updated = existing.filter((m) => m.skillId !== skillId);
    if (updated.length === 0) {
      this.mounts.delete(assistantId);
    } else {
      this.mounts.set(assistantId, updated);
    }
  }

  /**
   * 查询某助手当前挂载的 skills（完整 Skill 对象列表）。
   */
  getMounted(assistantId: PermanentId): Skill[] {
    const mounts = this.mounts.get(assistantId) ?? [];
    return mounts
      .map((m) => this.registry.get(m.skillId))
      .filter((s): s is Skill => s !== undefined);
  }

  /**
   * 查询某助手当前挂载的 SkillMount 记录（含元数据）。
   */
  getMountRecords(assistantId: PermanentId): SkillMount[] {
    return [...(this.mounts.get(assistantId) ?? [])];
  }

  /**
   * 按 id 直接获取 Skill（供主脑或 orchestrator 引用）。
   */
  get(skillId: string): Skill | undefined {
    return this.registry.get(skillId);
  }

  /**
   * 返回注册表中所有 skill ids（调试 / 健康检查用）。
   */
  listIds(): string[] {
    return Array.from(this.registry.keys());
  }

  // ── 内置 Skills ──────────────────────────────────────────

  /**
   * 标准内置 skills，constructor 自动调用。
   * 每个 skill 带完整 MCP-compatible JSON Schema。
   */
  private registerBuiltins(): void {
    // ── web-search ─────────────────────────────────────────
    this.register({
      id: 'web-search',
      name: 'Web Search',
      description: '执行网络搜索，返回相关页面的 url / title / snippet 列表',
      category: 'information',
      version: '1.0.0',
      tags: ['search', 'web', 'information', 'retrieval'],
      mcpTool: 'web_search',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或自然语言问题',
          },
          maxResults: {
            type: 'number',
            description: '返回结果数量上限，默认 10',
            default: 10,
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['results'],
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              required: ['url', 'title', 'snippet'],
              properties: {
                url: { type: 'string', format: 'uri' },
                title: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
        },
      },
    });

    // ── code-runner ────────────────────────────────────────
    this.register({
      id: 'code-runner',
      name: 'Code Runner',
      description: '在沙箱环境里执行代码，返回 stdout / stderr',
      category: 'compute',
      version: '1.0.0',
      tags: ['code', 'execute', 'sandbox', 'compute'],
      mcpTool: 'code_runner',
      inputSchema: {
        type: 'object',
        required: ['code', 'lang'],
        properties: {
          code: {
            type: 'string',
            description: '要执行的代码字符串',
          },
          lang: {
            type: 'string',
            enum: ['python', 'javascript', 'typescript', 'bash', 'ruby'],
            description: '代码语言',
          },
          timeout: {
            type: 'number',
            description: '执行超时（秒），默认 30',
            default: 30,
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stdout', 'stderr'],
        properties: {
          stdout: { type: 'string', description: '标准输出' },
          stderr: { type: 'string', description: '标准错误' },
          exitCode: { type: 'number', description: '进程退出码' },
        },
      },
    });

    // ── file-reader ────────────────────────────────────────
    this.register({
      id: 'file-reader',
      name: 'File Reader',
      description: '读取文件内容，支持文本和 base64 编码的二进制文件',
      category: 'file',
      version: '1.0.0',
      tags: ['file', 'read', 'storage', 'io'],
      mcpTool: 'file_reader',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对或相对路径',
          },
          encoding: {
            type: 'string',
            enum: ['utf-8', 'base64'],
            default: 'utf-8',
            description: '读取编码，二进制文件用 base64',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
          content: {
            type: 'string',
            description: '文件内容（按 encoding 编码）',
          },
          size: { type: 'number', description: '文件大小（字节）' },
          mimeType: { type: 'string', description: '检测到的 MIME 类型' },
        },
      },
    });

    // ── image-analyzer ─────────────────────────────────────
    this.register({
      id: 'image-analyzer',
      name: 'Image Analyzer',
      description: '对图片 URL 进行视觉分析，返回自然语言描述与标签',
      category: 'vision',
      version: '1.0.0',
      tags: ['image', 'vision', 'analyze', 'multimodal'],
      mcpTool: 'image_analyzer',
      inputSchema: {
        type: 'object',
        required: ['imageUrl'],
        properties: {
          imageUrl: {
            type: 'string',
            format: 'uri',
            description: '图片的公开可访问 URL',
          },
          detail: {
            type: 'string',
            enum: ['low', 'high'],
            default: 'high',
            description: '分析精细度',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['description', 'tags'],
        properties: {
          description: {
            type: 'string',
            description: '图片的自然语言描述',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '检测到的标签列表',
          },
          objects: {
            type: 'array',
            items: { type: 'string' },
            description: '识别到的物体',
          },
        },
      },
    });
  }
}
