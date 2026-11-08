import type { PermanentId, StandardTool } from './constants.js';

// ─── 会议室 ───────────────────────────────────────────────────
export interface Agenda {
  topic: string;
  context: Record<string, unknown>;
  urgency: 'low' | 'normal' | 'high' | 'emergency';
  suggestedParticipants?: PermanentId[];
  initiator: string; // developer/admin id
}

export interface Statement {
  speaker: PermanentId | typeof import('./constants.js').BRAIN_ID;
  content: string;
  timestamp: Date;
}

export interface Meeting {
  id: string;
  topic: string;
  participants: PermanentId[];
  status: 'open' | 'deliberating' | 'archived';
  transcript: Statement[];
  createdAt: Date;
}

export interface ActionItem {
  what: string;
  who: PermanentId;
  deadline?: Date;
}

export interface MeetingSummary {
  meetingId: string;
  topic: string;
  decisions: string[];
  actionItems: ActionItem[];
  archivedAt: Date;
  // 主脑生成的挂载指令（可为空）
  mountDirectives?: MountDirective[];
}

// ─── 挂载表 ──────────────────────────────────────────────────
export interface MountEntry {
  toolId: string;           // e.g. 'std.browser' | 'warehouse.code-runner'
  assistantId: PermanentId;
  source: 'pre-mount' | 'task-mount' | 'meeting-directive';
  meetingId?: string;       // 来源会议 ID（task-mount 时填）
  mountedAt: Date;
  expiresAt?: Date;         // 临时挂载到期时间
  lockedDuringMeeting: boolean; // 会议期间不可收回
}

export interface MountDirective {
  action: 'mount' | 'unmount';
  assistantId: PermanentId;
  toolId: string;
  reason: string;
}

// ─── Skills Bank ─────────────────────────────────────────────
export interface Skill {
  id: string;               // e.g. 'web-search'
  name: string;
  description: string;
  category: string;
  version: string;
  // MCP tool schema
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  mcpTool: string;          // MCP tool name to call
  tags: string[];
}

export interface SkillMount {
  skillId: string;
  assistantId: PermanentId;
  mountedAt: Date;
  meetingId?: string;
}

// ─── Tool Warehouse ──────────────────────────────────────────
export interface WarehouseTool {
  id: string;               // e.g. 'warehouse.code-runner'
  name: string;
  description: string;
  modalities: Array<'text' | 'image' | 'audio' | 'file'>;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  mcpServer: string;        // 对应的 MCP server name
  mcpTool: string;          // MCP tool name
  requiredKeyName?: string; // 需要主脑分配的密钥名
}

export interface ToolMount {
  toolId: string;
  assistantId: PermanentId;
  keyRef?: string;          // 分配的密钥引用（值不在这里）
  mountedAt: Date;
  meetingId?: string;
}

// ─── 密钥系统 ────────────────────────────────────────────────
export interface KeyRef {
  name: string;
  refId: string;            // 指向 SecretManager 里的值，主脑不读
  totalQuota: number;
  allocations: Map<string, number>; // assistantId → quota
  createdAt: Date;
  expiresAt?: Date;
}

export interface KeyGenConfig {
  type: 'subrouter' | 'supabase' | 'custom-api';
  quota: number;
  ttl?: number;             // ms，null = 永不过期
  scopes?: string[];
}

export interface ResourceQuota {
  tokens: number;
  requestsPerMin?: number;
}

// ─── 客制小助手（槽位附属）────────────────────────────────────
export interface CustomAssistant {
  id: string;
  displayName: string;
  baseAssistant: PermanentId; // 所属槽位
  customInstruction: string;
  allowedTools: string[];     // ⊆ baseAssistant 当前挂载工具
  quota: ResourceQuota;       // ≤ baseAssistant 配额
  inheritsFromVersion: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  // 会议室状态
  meetingRole: typeof import('./constants.js').MEETING_ROLES.CUSTOM_NAKED;
  // 裸进：无工具挂载，只有发言权
}

// ─── 助手状态与进化 ──────────────────────────────────────────
export interface AssistantState {
  id: PermanentId;
  status: 'active' | 'isolated' | 'recovering';
  currentVersion: string;
  mountedTools: string[];   // 当前挂载工具 ID 列表
  mountedSkills: string[];  // 当前挂载 Skill ID 列表
  errorRate: number;
  lastHealthCheck: Date;
}

export interface TaskSignal {
  taskId: string;
  assistantId: PermanentId;
  latencyMs: number;
  resolved: boolean;
  failed: boolean;
  handedBack: boolean;
  feedback?: 'thumbs_up' | 'thumbs_down' | 'followed_up';
}

export interface EvalResult {
  assistantId: PermanentId;
  avgScore: number;
  analysis: string;
  suggestionSource: PermanentId; // 分析来自哪个助手（delegate）
}

// ─── 开发者 / 用户 ───────────────────────────────────────────
export interface Developer {
  id: string;
  role: 'developer' | 'admin';
}

export type UserId = string;

// ─── 工具 ────────────────────────────────────────────────────
export type JSONSchema = Record<string, unknown>;

export class AccessDeniedError extends Error {
  constructor(msg: string) {
    super(`[AccessDenied] ${msg}`);
    this.name = 'AccessDeniedError';
  }
}

export class ConstitutionViolationError extends Error {
  constructor(action: string) {
    super(`[宪章违规] 主脑不得执行: ${action}`);
    this.name = 'ConstitutionViolationError';
  }
}
