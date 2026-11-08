/**
 * watchdog.ts — 保活层 (SurvivalWatchdog)
 *
 * 宪章约束：
 *  1. Watchdog 只做隔离、降档、扩容、压缩内存，不做功能性修改
 *  2. 告警通过 announce 发出（写会议室 log / console），不自动召开会议
 *  3. 自愈恢复使用 factoryRegistry 中最后稳定版本，不自己生成 Prompt
 */

import { PERMANENT_ASSISTANTS } from './constants.js';
import type { PermanentId } from './constants.js';
import type { Observer } from './observer.js';

// ─── External interfaces (not implemented here) ───────────────────────────────

/**
 * clawbot：助手状态控制机器人（实现层由 Clawbot 模块提供）
 */
declare const clawbot: {
  /** 设置助手运行状态 */
  setStatus(id: PermanentId, status: 'active' | 'isolated' | 'recovering'): void;
  /** 热更新助手系统提示 */
  hotUpdate(id: PermanentId, patch: { systemPrompt: string }): void;
  /** 读取助手近期错误率（0–1） */
  getErrorRate(id: PermanentId): number;
  /** 读取助手 P95 延迟（ms） */
  getP95Latency(id: PermanentId): number;
  /** 读取全局内存占用率（0–1） */
  getMemoryUsage(): number;
  /** 读取 SubRouter 剩余额度比例（0–1） */
  getSubRouterQuota(): number;
  /** 读取当前服务档位名称 */
  getCurrentTier(): string;
  /** 降低服务档位 */
  downgradeTier(): Promise<void>;
  /** 激活额度扩容 */
  activateResourceExpansion(): Promise<void>;
  /** 压缩内存（释放低优先级缓存） */
  compressMemory(): Promise<void>;
};

/**
 * factoryRegistry：Prompt 版本仓库
 */
declare const factoryRegistry: {
  getLastStable(id: PermanentId): Promise<{ content: string; id: string }>;
};

// ─── SurvivalWatchdog ─────────────────────────────────────────────────────────

export class SurvivalWatchdog {
  /** 健康检查间隔 30s */
  readonly HEALTH_INTERVAL = 30_000;
  /** 错误率阈值 30% → 隔离 */
  readonly CRITICAL_ERROR_RATE = 0.3;
  /** P95 延迟阈值 45s → 降档 */
  readonly CRITICAL_LATENCY = 45_000;
  /** 内存占用阈值 90% → 压缩 */
  readonly CRITICAL_MEMORY = 0.9;
  /** SubRouter 额度低水位 20% → 扩容 */
  private readonly LOW_QUOTA_THRESHOLD = 0.2;
  /** 隔离后自愈等待时间 2 分钟 */
  private readonly SELF_HEAL_DELAY = 2 * 60 * 1000;

  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** observer 引用（可选），用于状态推送 */
  private readonly observer?: Observer;

  constructor(observer?: Observer) {
    this.observer = observer;
  }

  // ─── 启动 / 停止 ──────────────────────────────────────────────────────────

  /**
   * 启动健康检查循环（每 30s 触发一次）。
   * 启动时立即执行首次检查，再按间隔循环。
   */
  async start(): Promise<void> {
    this.announce('SurvivalWatchdog 已启动，健康检查间隔 30s');

    // 首次立即检查
    await this.healthCheck();

    this.healthTimer = setInterval(() => {
      this.healthCheck().catch((err: unknown) => {
        console.error('[SurvivalWatchdog] healthCheck unhandled error:', err);
      });
    }, this.HEALTH_INTERVAL);
  }

  /**
   * 停止健康检查（测试 / 优雅关闭用）。
   */
  stop(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ─── 核心：健康检查 ───────────────────────────────────────────────────────

  /**
   * 一次健康检查（每 30s 执行）：
   *  1. 对每个永久助手：错误率 > 30% → 隔离（后续自愈）
   *  2. 对每个永久助手：P95 延迟 > 45s → 降档 + 通告
   *  3. SubRouter 额度 < 20% → 激活扩容
   *  4. 全局内存 > 90% → 压缩内存
   */
  private async healthCheck(): Promise<void> {
    // 1 & 2：逐助手检查
    for (const aid of PERMANENT_ASSISTANTS) {
      const errorRate = clawbot.getErrorRate(aid);

      if (errorRate > this.CRITICAL_ERROR_RATE) {
        this.announce(
          `⚠️ [${aid}] 错误率 ${(errorRate * 100).toFixed(1)}% > 30%，触发隔离`
        );
        await this.isolateAssistant(aid);
        // 已隔离，本轮跳过延迟检查（self-heal 后会恢复）
        continue;
      }

      const p95 = clawbot.getP95Latency(aid);
      if (p95 > this.CRITICAL_LATENCY) {
        this.announce(
          `⚠️ [${aid}] P95 延迟 ${p95}ms > 45s，触发降档`
        );
        await clawbot.downgradeTier();
        this.announce(`[${aid}] 已降档，当前 tier: ${clawbot.getCurrentTier()}`);
      }
    }

    // 3. SubRouter 额度检查
    const quota = clawbot.getSubRouterQuota();
    if (quota < this.LOW_QUOTA_THRESHOLD) {
      this.announce(
        `⚠️ SubRouter 剩余额度 ${(quota * 100).toFixed(1)}% < 20%，激活扩容`
      );
      await clawbot.activateResourceExpansion();
    }

    // 4. 全局内存检查
    const memory = clawbot.getMemoryUsage();
    if (memory > this.CRITICAL_MEMORY) {
      this.announce(
        `⚠️ 全局内存占用 ${(memory * 100).toFixed(1)}% > 90%，触发内存压缩`
      );
      await clawbot.compressMemory();
    }
  }

  // ─── 隔离与自愈 ──────────────────────────────────────────────────────────

  /**
   * 隔离指定助手：
   *  1. clawbot.setStatus → isolated
   *  2. 2 分钟后调用 selfHeal
   */
  private async isolateAssistant(aid: PermanentId): Promise<void> {
    clawbot.setStatus(aid, 'isolated');
    this.announce(`🔒 [${aid}] 已隔离，${this.SELF_HEAL_DELAY / 1000}s 后尝试自愈`);

    // 推送状态变更给 Observer（若已注入）
    if (this.observer) {
      const current = this.observer.readState(aid);
      this.observer.pushState(aid, { ...current, status: 'isolated' });
    }

    setTimeout(() => {
      this.selfHeal(aid).catch((err: unknown) => {
        this.announce(`❌ [${aid}] 自愈失败：${String(err)}`);
        console.error(`[SurvivalWatchdog] selfHeal(${aid}) error:`, err);
      });
    }, this.SELF_HEAL_DELAY);
  }

  /**
   * 自愈流程：
   *  1. 从 factoryRegistry 取最后稳定版本 Prompt
   *  2. clawbot.hotUpdate 热注入新 systemPrompt
   *  3. clawbot.setStatus → active
   */
  private async selfHeal(aid: PermanentId): Promise<void> {
    this.announce(`🔄 [${aid}] 开始自愈...`);

    const stableVersion = await factoryRegistry.getLastStable(aid);
    clawbot.hotUpdate(aid, { systemPrompt: stableVersion.content });
    clawbot.setStatus(aid, 'active');

    // 推送恢复状态给 Observer
    if (this.observer) {
      const current = this.observer.readState(aid);
      this.observer.pushState(aid, {
        ...current,
        status: 'active',
        currentVersion: stableVersion.id,
      });
    }

    this.announce(
      `✅ [${aid}] 自愈完成，已恢复至稳定版本 ${stableVersion.id}`
    );
  }

  // ─── 通告 ─────────────────────────────────────────────────────────────────

  /**
   * 通过主脑嘴发言（只在会议室，或写 log）。
   * 不调用模型，只做结构化日志输出供主脑层收集。
   */
  private announce(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`[SurvivalWatchdog][${ts}] ${msg}`);
  }
}
