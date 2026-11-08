/**
 * KeyVault — 主脑密钥管理层
 *
 * 宪章约束：
 *   - 主脑只持有密钥引用（KeyRef），永远不持有密钥明文
 *   - getValue() 违反宪章，直接 throw
 *   - 所有操作通过 delegate('forty-cents', ...) 写审计日志
 *   - allocate 时通过 clawbot.grantKey 通知目标助手
 */

import { ConstitutionViolationError } from './types.js';
import type { KeyRef, KeyGenConfig, ResourceQuota } from './types.js';
import { PERMANENT_ASSISTANTS, type PermanentId } from './constants.js';

// ─── 外部接口占位（运行时由 DI / mock 注入）────────────────────

declare const clawbot: {
  grantKey(assistantId: PermanentId, keyName: string, quota: ResourceQuota): Promise<void>;
  revokeKey(assistantId: PermanentId, keyName: string): Promise<void>;
};

declare function delegate(
  target: PermanentId,
  payload: {
    type: 'log';
    table: string;
    data: Record<string, unknown>;
  }
): Promise<void>;

// ─── KeyVault ─────────────────────────────────────────────────

export class KeyVault {
  /**
   * 密钥引用仓库。key = keyName，value = KeyRef（无明文）。
   */
  private readonly refs = new Map<string, KeyRef>();

  // ──────────────────────────────────────────────────────────
  // 宪章守卫
  // ──────────────────────────────────────────────────────────

  /**
   * 主脑不得读取密钥明文。调用即宪章违规。
   */
  getValue(_keyName: string): never {
    throw new ConstitutionViolationError('getValue() — 主脑不持有密钥值');
  }

  // ──────────────────────────────────────────────────────────
  // 核心操作
  // ──────────────────────────────────────────────────────────

  /**
   * 生成新密钥并注册引用。
   * 实际密钥由 SecretManager 生成，这里只保存引用元数据。
   */
  async generate(keyName: string, config: KeyGenConfig): Promise<KeyRef> {
    if (this.refs.has(keyName)) {
      throw new Error(`KeyVault: 密钥 "${keyName}" 已存在，请先 revoke`);
    }

    const ref: KeyRef = {
      name: keyName,
      refId: `ref_${keyName}_${Date.now()}`,
      totalQuota: config.quota,
      allocations: new Map(),
      createdAt: new Date(),
      expiresAt: config.ttl != null ? new Date(Date.now() + config.ttl) : undefined,
    };

    this.refs.set(keyName, ref);

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'generate',
        keyName,
        refId: ref.refId,
        config,
        createdAt: ref.createdAt.toISOString(),
      },
    });

    return ref;
  }

  /**
   * 将密钥分配给指定助手，并通知 clawbot。
   */
  async allocate(
    assistantId: PermanentId,
    keyName: string,
    quota: ResourceQuota
  ): Promise<void> {
    const ref = this._requireRef(keyName);

    const usedQuota = this._usedQuota(ref);
    if (usedQuota + quota.tokens > ref.totalQuota) {
      throw new Error(
        `KeyVault: 密钥 "${keyName}" 配额不足 — 已用 ${usedQuota}/${ref.totalQuota}，申请 ${quota.tokens}`
      );
    }

    ref.allocations.set(assistantId, (ref.allocations.get(assistantId) ?? 0) + quota.tokens);

    // 通知助手侧 clawbot
    await clawbot.grantKey(assistantId, keyName, quota);

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'allocate',
        keyName,
        refId: ref.refId,
        assistantId,
        quota,
        allocatedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 收回指定助手的密钥使用权。
   */
  async revoke(assistantId: PermanentId, keyName: string): Promise<void> {
    const ref = this._requireRef(keyName);

    if (!ref.allocations.has(assistantId)) {
      throw new Error(`KeyVault: 助手 "${assistantId}" 未持有密钥 "${keyName}"`);
    }

    ref.allocations.delete(assistantId);
    await clawbot.revokeKey(assistantId, keyName);

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'revoke',
        keyName,
        refId: ref.refId,
        assistantId,
        revokedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 使密钥失效（从引用仓库删除，所有分配失效）。
   */
  async invalidate(keyName: string): Promise<void> {
    const ref = this._requireRef(keyName);
    const affectedAssistants = [...ref.allocations.keys()];

    // 批量收回 clawbot 权限
    await Promise.all(
      affectedAssistants.map((id) => clawbot.revokeKey(id as PermanentId, keyName))
    );

    this.refs.delete(keyName);

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'invalidate',
        keyName,
        refId: ref.refId,
        affectedAssistants,
        invalidatedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 紧急撤销所有密钥的所有分配（仅保留引用，不删除）。
   */
  async emergencyRevokeAll(): Promise<void> {
    const summary: Array<{ keyName: string; revoked: string[] }> = [];

    for (const [keyName, ref] of this.refs) {
      const affected = [...ref.allocations.keys()];

      await Promise.all(
        affected.map((id) => clawbot.revokeKey(id as PermanentId, keyName))
      );

      ref.allocations.clear();
      summary.push({ keyName, revoked: affected });
    }

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'emergency_revoke_all',
        summary,
        executedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 重新平衡配额 — 按 PERMANENT_ASSISTANTS 均分剩余配额。
   * 仅调整内部分配记录，不重新通知 clawbot（下次 allocate 时生效）。
   */
  async rebalance(keyName: string): Promise<void> {
    const ref = this._requireRef(keyName);
    const recipients = PERMANENT_ASSISTANTS.filter((id) => ref.allocations.has(id));

    if (recipients.length === 0) return;

    const perAssistant = Math.floor(ref.totalQuota / recipients.length);

    for (const id of recipients) {
      ref.allocations.set(id, perAssistant);
    }

    await delegate('forty-cents', {
      type: 'log',
      table: 'key_vault_log',
      data: {
        action: 'rebalance',
        keyName,
        refId: ref.refId,
        recipients,
        perAssistant,
        rebalancedAt: new Date().toISOString(),
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // 只读查询
  // ──────────────────────────────────────────────────────────

  /** 获取引用元数据（不含密钥值）。 */
  getRef(keyName: string): Readonly<KeyRef> | undefined {
    return this.refs.get(keyName);
  }

  /** 列出所有引用名称。 */
  listKeys(): string[] {
    return [...this.refs.keys()];
  }

  /** 获取某助手当前持有的所有密钥名。 */
  getKeysFor(assistantId: PermanentId): string[] {
    return [...this.refs.entries()]
      .filter(([, ref]) => ref.allocations.has(assistantId))
      .map(([name]) => name);
  }

  // ──────────────────────────────────────────────────────────
  // 私有工具
  // ──────────────────────────────────────────────────────────

  private _requireRef(keyName: string): KeyRef {
    const ref = this.refs.get(keyName);
    if (!ref) throw new Error(`KeyVault: 密钥引用 "${keyName}" 不存在`);
    return ref;
  }

  private _usedQuota(ref: KeyRef): number {
    let total = 0;
    for (const q of ref.allocations.values()) total += q;
    return total;
  }
}
