/**
 * tool-warehouse.ts
 *
 * ToolWarehouse — 可挂载工具的注册表，工具通过 MCP 协议调用。
 *
 * 约定：
 *  - toolId 前缀 `std.*`  = 预挂标准件（每个助手启动时自动挂载）
 *  - toolId 前缀 `warehouse.*` = 按需挂载件（主脑根据会议行动清单分配）
 *  两者走同一套 MCP 管道，区别只在挂载时机。
 */

import type { WarehouseTool, JSONSchema } from './types.js';

// ─────────────────────────────────────────────────────────────
// Search query interface
// ─────────────────────────────────────────────────────────────

export interface ToolSearchQuery {
  modality?: string;
  text?: string;
}

// ─────────────────────────────────────────────────────────────
// getCallInfo 返回结构
// ─────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  server: string;
  tool: string;
  schema: JSONSchema;
}

// ─────────────────────────────────────────────────────────────
// ToolWarehouse
// ─────────────────────────────────────────────────────────────

export class ToolWarehouse {
  /** tool id → WarehouseTool */
  private readonly registry = new Map<string, WarehouseTool>();

  /**
   * 工具关键词索引，用于 recommend() 的模糊匹配。
   * key = tool id, value = 拼接好的可搜索文本（小写）
   */
  private readonly keywordIndex = new Map<string, string>();

  /**
   * 推荐规则：任务描述关键词 → 工具 id 列表。
   * registerBuiltins() 后填充，recommend() 使用。
   */
  private recommendationRules: Array<{
    keywords: string[];
    toolIds: string[];
  }> = [];

  constructor() {
    this.registerBuiltins();
  }

  // ── 注册 ─────────────────────────────────────────────────

  /**
   * 注册一个仓库工具。重复 id 时静默覆盖。
   * 同时维护关键词索引。
   */
  register(tool: WarehouseTool): void {
    this.registry.set(tool.id, tool);

    // 构建关键词索引
    const indexText =
      `${tool.id} ${tool.name} ${tool.description} ${tool.modalities.join(' ')}`.toLowerCase();
    this.keywordIndex.set(tool.id, indexText);
  }

  // ── 查询 ─────────────────────────────────────────────────

  /**
   * 查询可用工具（主脑读会议行动清单后用来决定挂什么）。
   * modality 和 text 做 AND 过滤；全空查询返回全量。
   */
  search(query: ToolSearchQuery): WarehouseTool[] {
    const { modality, text } = query;
    const needle = text?.toLowerCase();

    return Array.from(this.registry.values()).filter((tool) => {
      // modality 过滤
      if (modality && !tool.modalities.includes(modality as WarehouseTool['modalities'][number])) {
        return false;
      }

      // 全文过滤：匹配关键词索引
      if (needle) {
        const haystack = this.keywordIndex.get(tool.id) ?? '';
        if (!haystack.includes(needle)) return false;
      }

      return true;
    });
  }

  /**
   * 根据会议行动清单里的任务描述，自动推荐需要挂载的工具列表。
   *
   * 策略：
   *  1. 先按 recommendationRules 做规则匹配（精确、高置信度）
   *  2. 若规则没命中，降级到全文搜索（search），取 top-N
   *  3. 去重后返回
   */
  recommend(taskDescription: string): WarehouseTool[] {
    const desc = taskDescription.toLowerCase();
    const matchedToolIds = new Set<string>();

    // ── 规则匹配 ──
    for (const rule of this.recommendationRules) {
      if (rule.keywords.some((kw) => desc.includes(kw))) {
        for (const id of rule.toolIds) {
          if (this.registry.has(id)) matchedToolIds.add(id);
        }
      }
    }

    // ── 降级全文搜索 ──
    if (matchedToolIds.size === 0) {
      const words = desc
        .split(/\s+/)
        .filter((w) => w.length > 2) // 过滤太短的词
        .slice(0, 5); // 取前 5 个词做命中

      if (words.length > 0) {
        for (const [, tool] of this.registry) {
          const haystack = this.keywordIndex.get(tool.id) ?? '';
          if (words.some((w) => haystack.includes(w))) {
            matchedToolIds.add(tool.id);
          }
        }
      }
    }

    return Array.from(matchedToolIds)
      .map((id) => this.registry.get(id))
      .filter((t): t is WarehouseTool => t !== undefined);
  }

  /**
   * 获取某工具的 MCP 调用信息（供助手使用时参考）。
   * 返回 server、tool name 和 input schema。
   */
  getCallInfo(toolId: string): ToolCallInfo | null {
    const tool = this.registry.get(toolId);
    if (!tool) return null;

    return {
      server: tool.mcpServer,
      tool: tool.mcpTool,
      schema: tool.inputSchema,
    };
  }

  // ── 辅助 ─────────────────────────────────────────────────

  /**
   * 按 id 直接获取工具定义。
   */
  get(toolId: string): WarehouseTool | undefined {
    return this.registry.get(toolId);
  }

  /**
   * 返回注册表中所有工具 id（调试 / 健康检查用）。
   */
  listIds(): string[] {
    return Array.from(this.registry.keys());
  }

  // ── 内置工具 ─────────────────────────────────────────────

  /**
   * 标准内置 warehouse 工具，constructor 自动调用。
   */
  private registerBuiltins(): void {
    // ── warehouse.browser ──────────────────────────────────
    this.register({
      id: 'warehouse.browser',
      name: 'Browser Automation',
      description: '浏览器自动化：导航、截图、点击、输入、提取页面内容',
      modalities: ['text', 'image'],
      mcpServer: 'browser-server',
      mcpTool: 'browser_automate',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'click', 'type', 'screenshot', 'extract', 'scroll'],
            description: '要执行的浏览器操作',
          },
          url: { type: 'string', description: '导航目标 URL（action=navigate 时必填）' },
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '要输入的文本' },
          fullPage: { type: 'boolean', description: '截图是否截整页', default: false },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          content: { type: 'string', description: '提取的文本内容' },
          screenshot: { type: 'string', format: 'uri', description: '截图的 URL 或 base64' },
          error: { type: 'string', description: '错误信息（如果有）' },
        },
      },
    });

    // ── warehouse.terminal ─────────────────────────────────
    this.register({
      id: 'warehouse.terminal',
      name: 'Terminal Executor',
      description: '在安全沙箱里执行 shell 命令，返回 stdout / stderr / exit code',
      modalities: ['text'],
      mcpServer: 'terminal-server',
      mcpTool: 'terminal_execute',
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          cwd: { type: 'string', description: '工作目录，默认 /tmp' },
          timeout: { type: 'number', description: '超时（秒），默认 60', default: 60 },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '额外环境变量',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stdout', 'stderr', 'exitCode'],
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'number' },
          durationMs: { type: 'number', description: '执行耗时（毫秒）' },
        },
      },
    });

    // ── warehouse.file-manager ────────────────────────────
    this.register({
      id: 'warehouse.file-manager',
      name: 'File Manager',
      description: '文件读写列表操作：read / write / list / delete / mkdir',
      modalities: ['text', 'file'],
      mcpServer: 'file-server',
      mcpTool: 'file_manager',
      inputSchema: {
        type: 'object',
        required: ['action', 'path'],
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'list', 'delete', 'mkdir'],
            description: '文件操作类型',
          },
          path: { type: 'string', description: '目标路径' },
          content: { type: 'string', description: '写入内容（action=write 时必填）' },
          encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' },
          recursive: { type: 'boolean', description: '是否递归（list/delete/mkdir）', default: false },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          content: { type: 'string', description: '读取的文件内容' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['file', 'directory'] },
                size: { type: 'number' },
              },
            },
            description: '目录列表结果',
          },
          error: { type: 'string' },
        },
      },
    });

    // ── warehouse.text-processor ──────────────────────────
    this.register({
      id: 'warehouse.text-processor',
      name: 'Text Processor',
      description: '文本解析与变换：parse JSON / parse CSV / transform / extract / format',
      modalities: ['text', 'file'],
      mcpServer: 'text-server',
      mcpTool: 'text_process',
      inputSchema: {
        type: 'object',
        required: ['action', 'input'],
        properties: {
          action: {
            type: 'string',
            enum: ['parse-json', 'parse-csv', 'parse-yaml', 'transform', 'extract', 'format'],
            description: '处理动作',
          },
          input: { type: 'string', description: '待处理的文本内容' },
          format: {
            type: 'string',
            enum: ['json', 'csv', 'yaml', 'xml', 'markdown'],
            description: '目标格式（format/transform 时用）',
          },
          query: {
            type: 'string',
            description: 'JSONPath / XPath / 正则（extract 时用）',
          },
          delimiter: { type: 'string', default: ',', description: 'CSV 分隔符' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          result: { description: '处理结果（结构化数据或字符串）' },
          error: { type: 'string' },
        },
      },
    });

    // ── warehouse.image-gen ───────────────────────────────
    this.register({
      id: 'warehouse.image-gen',
      name: 'Image Generator',
      description: '文本生成图片：输入文字描述，输出生成的图片 URL / base64',
      modalities: ['image'],
      mcpServer: 'image-gen-server',
      mcpTool: 'image_generate',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: '生成图片的文字描述' },
          size: {
            type: 'string',
            enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'],
            default: '1024x1024',
          },
          n: { type: 'number', description: '生成数量', default: 1, minimum: 1, maximum: 4 },
          style: {
            type: 'string',
            enum: ['natural', 'vivid'],
            description: '图像风格',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                base64: { type: 'string' },
                revisedPrompt: { type: 'string', description: '模型修订后的 prompt' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
    });

    // ── 推荐规则 ──────────────────────────────────────────
    // 主脑读会议行动清单后，根据任务描述匹配规则推荐工具
    this.recommendationRules = [
      {
        keywords: ['browser', '网页', '网站', 'navigate', 'scrape', 'crawl', '截图', '浏览器'],
        toolIds: ['warehouse.browser'],
      },
      {
        keywords: ['terminal', 'shell', '命令', 'execute', 'bash', '终端', '脚本执行'],
        toolIds: ['warehouse.terminal'],
      },
      {
        keywords: ['file', '文件', 'read', 'write', '目录', 'folder', '读写', 'list'],
        toolIds: ['warehouse.file-manager'],
      },
      {
        keywords: ['csv', 'json', 'yaml', 'parse', 'format', 'transform', '文本处理', '解析'],
        toolIds: ['warehouse.text-processor'],
      },
      {
        keywords: ['image', '图片', '生成图', 'draw', 'picture', '画图', 'dalle', '图生'],
        toolIds: ['warehouse.image-gen'],
      },
    ];
  }
}
