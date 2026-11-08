/**
 * MountTable — 主脑工具挂载层
 *
 * 设计原则：
 *   - 持引用不持值，分配给助手，可回收（与 KeyVault 同属资源分配层）
 *   - 实例化时为所有 PERMANENT_ASSISTANTS 预挂 STANDARD_TOOLKIT
 *   - 会议期间锁住目标助手工具包，防止被 unmount
 *   - 所有操作通过 delegate('forty-cents', ...) 写审计日志
 */

import type { MountEntry, MountDirective } from './types.js';
import {
  PERMANENT_ASSISTANTS,
  STANDARD_TOOLKIT,
  type PermanentId,
} from './constants.js';

// ─── 外部接口占位（运行时由 DI / mock 注入）────────────────────

declare function delegate(
  target: PermanentId,
  payload: {
    type: 'log';
    table: string;
    data: Record<string, unknown>;
  }
): Promise<void>;

// ─── MountTable ───────────────────────────────────────────────

export class MountTable {
  private readonly entries: MountEntry[] = [];

  /** 会议期间被锁定的助手 ID 集合。 */
  private readonly lockedAssistants = new Set<PermanentId>();

  constructor() {
    // 实例化时为所有永久助手预挂标准工具包
    const now = new Date();
    for (const assistantId of PERMANENT_ASSISTANTS) {
      for (const toolId of STANDARD_TOOLKIT) {
        this.entries.push({
          toolId,
          assistantId,
          source: 'pre-mount',
          mountedAt: now,
          lockedDuringMeeting: false,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 预挂（出厂配置）
  // ──────────────────────────────────────────────────────────

  /**
   * 为助手预挂单个工具（STANDARD_TOOLKIT 之外的补充预挂）。
   * 若该工具已挂载，则幂等跳过。
   */
  async preMount(assistantId: PermanentId, toolId: string): Promise<void> {
    if (this._isMounted(assistantId, toolId)) return;

    const entry: MountEntry = {
      toolId,
      assistantId,
      source: 'pre-mount',
      mountedAt: new Date(),
      lockedDuringMeeting: false,
    };

    this.entries.push(entry);

    await delegate('forty-cents', {
      type: 'log',
      table: 'mount_table_log',
      data: {
        action: 'pre_mount',
        assistantId,
        toolId,
        mountedAt: entry.mountedAt.toISOString(),
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // 任务挂载（来自会议决议）
  // ──────────────────────────────────────────────────────────

  /**
   * 为助手挂载任务工具（会议决议产出）。
   */
  async mount(
    assistantId: PermanentId,
    toolId: string,
    meetingId: string,
    expiresAt?: Date
  ): Promise<void> {
    if (this._isMounted(assistantId, toolId)) return;

    const entry: MountEntry = {
      toolId,
      assistantId,
      source: 'task-mount',
      meetingId,
      mountedAt: new Date(),
      expiresAt,
      lockedDuringMeeting: this.lockedAssistants.has(assistantId),
    };

    this.entries.push(entry);

    await delegate('forty-cents', {
      type: 'log',
      table: 'mount_table_log',
      data: {
        action: 'mount',
        assistantId,
        toolId,
        meetingId,
        expiresAt: expiresAt?.toISOString() ?? null,
        mountedAt: entry.mountedAt.toISOString(),
      },
    });
  }

  /**
   * 收回助手的工具挂载。
   * 若助手在会议期间被锁定，则拒绝收回（抛出错误）。
   */
  async unmount(assistantId: PermanentId, toolId: string): Promise<void> {
    if (this.lockedAssistants.has(assistantId)) {
      throw new Error(
        `MountTable: 助手 "${assistantId}" 正在会议中，工具包已锁定，不允许 unmount`
      );
    }

    const idx = this.entries.findIndex(
      (e) => e.assistantId === assistantId && e.toolId === toolId
    );

    if (idx === -1) {
      throw new Error(
        `MountTable: 助手 "${assistantId}" 未挂载工具 "${toolId}"`
      );
    }

    const [removed] = this.entries.splice(idx, 1);

    await delegate('forty-cents', {
      type: 'log',
      table: 'mount_table_log',
      data: {
        action: 'unmount',
        assistantId,
        toolId,
        source: removed.source,
        meetingId: removed.meetingId ?? null,
        unmountedAt: new Date().toISOString(),
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // 会议锁
  // ──────────────────────────────────────────────────────────

  /**
   * 会议开始：锁住助手工具包，会议期间不允许 unmount。
   */
  async lockForMeeting(assistantId: PermanentId): Promise<void> {
    this.lockedAssistants.add(assistantId);

    // 将当前所有挂载项标记为 lockedDuringMeeting
    for (const entry of this.entries) {
      if (entry.assistantId === assistantId) {
        entry.lockedDuringMeeting = true;
      }
    }

    await delegate('forty-cents', {
      type: 'log',
      table: 'mount_table_log',
      data: {
        action: 'lock_for_meeting',
        assistantId,
        lockedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 会议结束：解锁助手工具包。
   */
  async unlockAfterMeeting(assistantId: PermanentId): Promise<void> {
    this.lockedAssistants.delete(assistantId);

    for (const entry of this.entries) {
      if (entry.assistantId === assistantId) {
        entry.lockedDuringMeeting = false;
      }
    }

    await delegate('forty-cents', {
      type: 'log',
      table: 'mount_table_log',
      data: {
        action: 'unlock_after_meeting',
        assistantId,
        unlockedAt: new Date().toISOString(),
      },
    });
  }

  // ──────────────────────────────────────────────────────────
  // 查询
  // ──────────────────────────────────────────────────────────

  /**
   * 获取助手当前所有已挂载工具 ID（过期工具自动过滤）。
   */
  getMountedTools(assistantId: PermanentId): string[] {
    const now = new Date();
    return this.entries
      .filter(
        (e) =>
          e.assistantId === assistantId &&
          (e.expiresAt == null || e.expiresAt > now)
      )
      .map((e) => e.toolId);
  }

  // ──────────────────────────────────────────────────────────
  // 批量指令（会议产出）
  // ──────────────────────────────────────────────────────────

  /**
   * 批量执行会议产出的挂载指令。
   * mount 指令需携带 meetingId（从指令 reason 字段提取，或使用 'directive' 占位）。
   */
  async applyDirectives(directives: MountDirective[]): Promise<void> {
    for (const directive of directives) {
      const { action, assistantId, toolId } = directive;

      if (action === 'mount') {
        // meeting-directive 来源
        const entry: MountEntry = {
          toolId,
          assistantId,
          source: 'meeting-directive',
          mountedAt: new Date(),
          lockedDuringMeeting: this.lockedAssistants.has(assistantId),
        };

        if (!this._isMounted(assistantId, toolId)) {
          this.entries.push(entry);
        }

        await delegate('forty-cents', {
          type: 'log',
          table: 'mount_table_log',
          data: {
            action: 'directive_mount',
            assistantId,
            toolId,
            reason: directive.reason,
            mountedAt: entry.mountedAt.toISOString(),
          },
        });
      } else if (action === 'unmount') {
        if (this.lockedAssistants.has(assistantId)) {
          // 指令期间锁定 — 记录跳过日志，不抛错（会议内部指令走软跳过）
          await delegate('forty-cents', {
            type: 'log',
            table: 'mount_table_log',
            data: {
              action: 'directive_unmount_skipped',
              assistantId,
              toolId,
              reason: `assistant locked during meeting — skipped`,
              skippedAt: new Date().toISOString(),
            },
          });
          continue;
        }

        const idx = this.entries.findIndex(
          (e) => e.assistantId === assistantId && e.toolId === toolId
        );

        if (idx !== -1) {
          this.entries.splice(idx, 1);
        }

        await delegate('forty-cents', {
          type: 'log',
          table: 'mount_table_log',
          data: {
            action: 'directive_unmount',
            assistantId,
            toolId,
            reason: directive.reason,
            unmountedAt: new Date().toISOString(),
          },
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 私有工具
  // ──────────────────────────────────────────────────────────

  private _isMounted(assistantId: PermanentId, toolId: string): boolean {
    return this.entries.some(
      (e) => e.assistantId === assistantId && e.toolId === toolId
    );
  }

  /** 快照（只读），用于调试 / 测试。 */
  snapshot(): ReadonlyArray<MountEntry> {
    return this.entries;
  }
}
