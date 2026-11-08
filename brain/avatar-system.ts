/**
 * avatar-system.ts — 客制助手管理系统 (AvatarSystem)
 *
 * 宪章约束（不可绕过）：
 *  1. 客制助手必须附属于某个永久助手槽位（baseAssistant: PermanentId）
 *  2. allowedTools ⊆ baseAssistant 当前挂载工具（由 MountTable 验证，违规 throw）
 *  3. quota.tokens ≤ baseAssistant 配额（违规 throw）
 *  4. 进化跟随 baseAssistant 自动更新（syncOnEvolution）
 *  5. 进会议室时角色永远是 MEETING_ROLES.CUSTOM_NAKED（裸进，有发言权，无工具）
 */

import { PERMANENT_ASSISTANTS, MEETING_ROLES } from './constants.js';
import type { PermanentId } from './constants.js';
import type { CustomAssistant, ResourceQuota } from './types.js';
import { AccessDeniedError, ConstitutionViolationError } from './types.js';

// ─── External interfaces (not implemented here) ───────────────────────────────

/** 将任务委派给指定永久助手（AvatarSystem 的唯一外部调用路径） */
declare function delegate(assistantId: PermanentId, task: unknown): Promise<unknown>;

/** 挂载表：获取某永久助手当前已挂载的工具列表 */
declare const mountTable: { getMountedTools(id: PermanentId): string[] };

/** Supabase 客户端（主脑层统一提供） */
declare const supabase: {
  from(table: string): {
    insert(row: unknown): Promise<{ error: unknown | null }>;
    update(values: unknown): {
      eq(col: string, val: string): Promise<{ error: unknown | null }>;
    };
    select(cols?: string): {
      eq(col: string, val: string): Promise<{ data: unknown[] | null; error: unknown | null }>;
    };
  };
};

// ─── baseAssistant 配额查询（通过 delegate 获取，主脑不直接持有配额数据）─────
// 由于配额属于助手自身状态，从 MountTable / AssistantState 里读取；
// 这里通过一个本地 helper 函数形式声明（调用方: create 内部校验）。
declare function getBaseQuota(assistantId: PermanentId): Promise<ResourceQuota>;

// ─── AvatarSystem ─────────────────────────────────────────────────────────────

export class AvatarSystem {
  /**
   * 内存注册表：id → CustomAssistant。
   * 作为 isCustom / getById 的快速查询层，与 Supabase 双写。
   */
  private readonly registry = new Map<string, CustomAssistant>();

  // ─── 创建客制助手 ──────────────────────────────────────────────────────────

  /**
   * 创建并注册一个新的客制助手。
   *
   * 校验流程（全部通过才写库）：
   *  1. baseAssistant 必须是合法 PermanentId
   *  2. allowedTools ⊆ baseAssistant 当前挂载工具（MountTable 验证）
   *  3. quota.tokens ≤ baseAssistant 当前配额（违规 throw ConstitutionViolationError）
   *  4. meetingRole 强制锁定为 CUSTOM_NAKED，不接受外部传入
   */
  async create(config: {
    displayName: string;
    baseAssistant: PermanentId;
    customInstruction: string;
    allowedTools: string[];
    quota: ResourceQuota;
  }): Promise<CustomAssistant> {
    // 1. 验证 baseAssistant 合法性
    if (!(PERMANENT_ASSISTANTS as readonly string[]).includes(config.baseAssistant)) {
      throw new AccessDeniedError(
        `baseAssistant "${config.baseAssistant}" 不在 PERMANENT_ASSISTANTS 名单内`
      );
    }

    // 2. 验证 allowedTools ⊆ baseAssistant 当前挂载工具
    const mountedTools = mountTable.getMountedTools(config.baseAssistant);
    const illegalTools = config.allowedTools.filter((t) => !mountedTools.includes(t));
    if (illegalTools.length > 0) {
      throw new ConstitutionViolationError(
        `allowedTools 含非法项：[${illegalTools.join(', ')}] 未挂载在 ${config.baseAssistant}`
      );
    }

    // 3. 验证 quota.tokens ≤ baseAssistant 配额
    const baseQuota = await getBaseQuota(config.baseAssistant);
    if (config.quota.tokens > baseQuota.tokens) {
      throw new ConstitutionViolationError(
        `quota.tokens (${config.quota.tokens}) 超过 ${config.baseAssistant} 的配额上限 (${baseQuota.tokens})`
      );
    }

    // 4. 生成唯一 ID
    const avatarId = `avatar-${config.baseAssistant}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    // 5. 组装 CustomAssistant 对象（meetingRole 强制锁定）
    const avatar: CustomAssistant = {
      id: avatarId,
      displayName: config.displayName,
      baseAssistant: config.baseAssistant,
      customInstruction: config.customInstruction,
      allowedTools: config.allowedTools,
      quota: config.quota,
      inheritsFromVersion: 'unknown', // syncOnEvolution 首次同步时填入
      status: 'active',
      createdAt: new Date(),
      // 宪章：会议室角色永远是 CUSTOM_NAKED，不可被外部覆盖
      meetingRole: MEETING_ROLES.CUSTOM_NAKED,
    };

    // 6. 写入 Supabase avatars 表（通过 delegate 给 forty-cents 执行，主脑不持有 DB 凭证）
    await delegate('forty-cents', {
      type: 'db_write',
      table: 'avatars',
      row: {
        id: avatar.id,
        display_name: avatar.displayName,
        base_assistant: avatar.baseAssistant,
        custom_instruction: avatar.customInstruction,
        allowed_tools: JSON.stringify(avatar.allowedTools),
        quota_tokens: avatar.quota.tokens,
        quota_rpm: avatar.quota.requestsPerMin ?? null,
        inherits_from_version: avatar.inheritsFromVersion,
        status: avatar.status,
        created_at: avatar.createdAt.toISOString(),
        meeting_role: avatar.meetingRole,
      },
    });

    // 7. 写入内存注册表
    this.registry.set(avatarId, avatar);

    return avatar;
  }

  // ─── 进化同步 ─────────────────────────────────────────────────────────────

  /**
   * 当某永久助手进化（版本更新）后，同步其所有子客制助手：
   *  - 更新 inheritsFromVersion
   *  - 重新校验 allowedTools（若基座工具集缩减则移除非法项并记录警告）
   *  - 持久化到 Supabase
   */
  async syncOnEvolution(assistantId: PermanentId, newVersion: string): Promise<void> {
    const updatedMountedTools = mountTable.getMountedTools(assistantId);

    for (const [id, avatar] of this.registry.entries()) {
      if (avatar.baseAssistant !== assistantId) continue;

      // 重新过滤 allowedTools（基座工具集可能缩减）
      const validTools = avatar.allowedTools.filter((t) => updatedMountedTools.includes(t));
      const revokedTools = avatar.allowedTools.filter((t) => !updatedMountedTools.includes(t));

      if (revokedTools.length > 0) {
        console.warn(
          `[AvatarSystem] syncOnEvolution: avatar ${id} 的工具 [${revokedTools.join(', ')}] ` +
            `因 ${assistantId} 进化至 ${newVersion} 后已不再挂载，已自动移除`
        );
      }

      const updated: CustomAssistant = {
        ...avatar,
        allowedTools: validTools,
        inheritsFromVersion: newVersion,
      };

      this.registry.set(id, updated);

      // 持久化
      await delegate('forty-cents', {
        type: 'db_update',
        table: 'avatars',
        id,
        values: {
          allowed_tools: JSON.stringify(validTools),
          inherits_from_version: newVersion,
        },
      });
    }
  }

  // ─── 查询 ────────────────────────────────────────────────────────────────

  /**
   * 查询某 ID 是否是已注册的客制助手。
   * Voice.assertCanParticipate 调用此方法判断 CUSTOM_NAKED 准入。
   */
  isCustom(id: string): boolean {
    return this.registry.has(id);
  }

  /**
   * 通过 ID 获取客制助手详情。
   * 若不存在则 throw AccessDeniedError。
   */
  async getById(id: string): Promise<CustomAssistant> {
    const avatar = this.registry.get(id);
    if (!avatar) {
      throw new AccessDeniedError(`客制助手 "${id}" 未在注册表中找到`);
    }
    return avatar;
  }

  /**
   * 按槽位（baseAssistant）列出所有客制助手（含已暂停的）。
   */
  async listByBase(assistantId: PermanentId): Promise<CustomAssistant[]> {
    const results: CustomAssistant[] = [];
    for (const avatar of this.registry.values()) {
      if (avatar.baseAssistant === assistantId) {
        results.push(avatar);
      }
    }
    return results;
  }

  // ─── 暂停 ────────────────────────────────────────────────────────────────

  /**
   * 暂停客制助手（不删除，仍可恢复）。
   * 暂停后 isCustom 返回 true 但 Voice 层应拒绝暂停状态的助手进会议。
   */
  async suspend(avatarId: string): Promise<void> {
    const avatar = this.registry.get(avatarId);
    if (!avatar) {
      throw new AccessDeniedError(`suspend: 客制助手 "${avatarId}" 不存在`);
    }

    const suspended: CustomAssistant = { ...avatar, status: 'suspended' };
    this.registry.set(avatarId, suspended);

    await delegate('forty-cents', {
      type: 'db_update',
      table: 'avatars',
      id: avatarId,
      values: { status: 'suspended' },
    });
  }
}
