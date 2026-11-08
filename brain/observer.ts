/**
 * observer.ts — 只读监听器 (Observer)
 *
 * 宪章约束：
 *  1. Observer 只读不写，不得修改任何助手状态
 *  2. 状态快照每 30s 刷新一次（startSnapshotLoop）
 *  3. P2P 调用关系记录供 EvolutionLoop 分析使用
 */

import { PERMANENT_ASSISTANTS } from './constants.js';
import type { PermanentId } from './constants.js';
import type { AssistantState, Meeting } from './types.js';
import { getSupabase } from './di.js';

// ─── External interfaces (not implemented here) ───────────────────────────────

// (removed declare const supabase, now using getSupabase() from DI)

// ─── AssistantEvent ───────────────────────────────────────────────────────────

export interface AssistantEvent {
  type: 'message' | 'tool_call' | 'error' | 'status_change';
  assistantId: PermanentId;
  payload: unknown;
  timestamp: Date;
}

// ─── Observer ─────────────────────────────────────────────────────────────────

export class Observer {
  /** 快照存储：assistantId → AssistantState（30s 刷新） */
  private readonly snapshots = new Map<PermanentId, AssistantState>();

  /** 订阅者：assistantId → handler Set */
  private readonly subscribers = new Map<
    PermanentId,
    Set<(event: AssistantEvent) => void>
  >();

  /** P2P 工具调用图：`${from}→${tool}` → { calls, successRate } */
  private readonly peerCallGraph = new Map<
    string,
    { calls: number; successRate: number }
  >();

  /** 快照刷新定时器句柄 */
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  private readonly SNAPSHOT_INTERVAL = 30_000; // 30s

  constructor() {
    this.startSnapshotLoop();
  }

  // ─── 订阅 ─────────────────────────────────────────────────────────────────

  /**
   * 订阅某助手的消息流（只读，主脑只看不动）。
   * 同一 handler 重复注册会被 Set 自动去重。
   */
  subscribe(
    assistantId: PermanentId,
    handler: (event: AssistantEvent) => void
  ): void {
    if (!this.subscribers.has(assistantId)) {
      this.subscribers.set(assistantId, new Set());
    }
    this.subscribers.get(assistantId)!.add(handler);
  }

  /**
   * 取消订阅。
   */
  unsubscribe(
    assistantId: PermanentId,
    handler: (event: AssistantEvent) => void
  ): void {
    this.subscribers.get(assistantId)?.delete(handler);
  }

  /**
   * 分发事件给对应助手的所有订阅者（由助手运行层调用）。
   * Observer 自身不产生事件，只做中继。
   */
  emit(event: AssistantEvent): void {
    const handlers = this.subscribers.get(event.assistantId);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error(
          `[Observer] emit handler error for ${event.assistantId}:`,
          err
        );
      }
    }
  }

  // ─── 状态读取 ─────────────────────────────────────────────────────────────

  /**
   * 读取助手当前状态快照（内存缓存，30s 更新一次）。
   * 若快照尚未初始化，返回默认空状态（首次轮询前的占位）。
   */
  readState(assistantId: PermanentId): AssistantState {
    const cached = this.snapshots.get(assistantId);
    if (cached) return cached;

    // 默认空快照
    return {
      id: assistantId,
      status: 'active',
      currentVersion: 'unknown',
      mountedTools: [],
      mountedSkills: [],
      errorRate: 0,
      lastHealthCheck: new Date(0),
    };
  }

  /**
   * 读取历史会议记录（从 Supabase meetings 表，倒序取最近 n 条）。
   */
  async readMeetingHistory(n: number): Promise<Meeting[]> {
    const { data, error } = await getSupabase()
      .from('meetings')
      .select()
      .order('created_at', { ascending: false })
      .limit(n);

    if (error) {
      console.error('[Observer] readMeetingHistory error:', error);
      return [];
    }

    return (data ?? []) as Meeting[];
  }

  // ─── P2P 调用图 ──────────────────────────────────────────────────────────

  /**
   * 记录横向工具调用关系（P2P 调用时主脑旁观）。
   * key 格式：`${from}→${tool}`；采用滚动平均更新 successRate。
   */
  recordPeerCall(from: PermanentId, tool: string, success: boolean): void {
    const key = `${from}→${tool}`;
    const existing = this.peerCallGraph.get(key);

    if (!existing) {
      this.peerCallGraph.set(key, {
        calls: 1,
        successRate: success ? 1 : 0,
      });
      return;
    }

    const totalCalls = existing.calls + 1;
    const totalSuccesses =
      existing.successRate * existing.calls + (success ? 1 : 0);

    this.peerCallGraph.set(key, {
      calls: totalCalls,
      successRate: totalSuccesses / totalCalls,
    });
  }

  /**
   * 获取工具调用关系图（供 EvolutionLoop 分析）。
   * 返回快照副本，防止外部写入污染内部状态。
   */
  getPeerCallGraph(): Map<string, { calls: number; successRate: number }> {
    return new Map(this.peerCallGraph);
  }

  // ─── 外部推入接口 ─────────────────────────────────────────────────────────

  /**
   * 将新的助手状态推入 Observer（Watchdog / EvolutionLoop 调用）。
   * Observer 不持有权威状态，只缓存最新快照并触发订阅事件。
   */
  pushState(assistantId: PermanentId, state: AssistantState): void {
    this.updateSnapshot(assistantId, state);

    // 通知所有订阅者
    this.emit({
      type: 'status_change',
      assistantId,
      payload: state,
      timestamp: new Date(),
    });
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 停止快照刷新定时器（测试 / 优雅关闭用）。
   */
  stop(): void {
    if (this.snapshotTimer !== null) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────────

  /**
   * 启动快照刷新定时器。
   * 定时器每 30s 刷新所有已有快照的 lastHealthCheck 时间戳，
   * 保证即使没有 status_change 事件也有定期心跳记录。
   */
  private startSnapshotLoop(): void {
    this.snapshotTimer = setInterval(() => {
      for (const aid of PERMANENT_ASSISTANTS) {
        const existing = this.snapshots.get(aid);
        if (existing) {
          this.updateSnapshot(aid, existing);
        }
      }
    }, this.SNAPSHOT_INTERVAL);
  }

  /**
   * 保存状态快照（定期 30s 刷新 + status_change 事件触发）。
   * 每次写入都刷新 lastHealthCheck。
   */
  private updateSnapshot(
    assistantId: PermanentId,
    state: AssistantState
  ): void {
    this.snapshots.set(assistantId, {
      ...state,
      lastHealthCheck: new Date(),
    });
  }
}
