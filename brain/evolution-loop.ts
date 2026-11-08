/**
 * evolution-loop.ts — 自进化循环 (EvolutionLoop)
 *
 * 宪章约束：
 *  1. EvolutionLoop 不直接调用任何模型
 *     - 根因分析委托 duck-lee（delegate）
 *     - 新版 Prompt 生成委托 forty-cents（delegate）
 *  2. confidence < AUTO_EVOLVE_CONFIDENCE → 提交 OpenMaic 审议，不自动上线
 *  3. validate 数据不足 VALIDATION_WINDOW → 等待，不提前判断
 *  4. delta < ROLLBACK_DELTA → 回滚至上一稳定版本
 */

import { PERMANENT_ASSISTANTS } from './constants.js';
import type { PermanentId } from './constants.js';
import type { EvalResult, TaskSignal } from './types.js';
import type { AvatarSystem } from './avatar-system.js';

// ─── External interfaces (not implemented here) ───────────────────────────────

/**
 * 将任务委派给指定永久助手（EvolutionLoop 的唯一外部调用路径）
 */
declare function delegate(id: PermanentId, task: unknown): Promise<unknown>;

/**
 * clawbot：助手热更新控制
 */
declare const clawbot: {
  hotUpdate(id: PermanentId, patch: { systemPrompt: string }): void;
};

/**
 * factoryRegistry：Prompt 版本仓库
 */
declare const factoryRegistry: {
  /** 取某助手的最后稳定版本 */
  getLastStable(id: PermanentId): Promise<{ content: string; id: string }>;
  /** 按进化 ID 取版本详情 */
  getVersion(evolutionId: string): Promise<{
    assistantId: PermanentId;
    promptContent: string;
    baselineScore: number;
    status: 'pending' | 'validating' | 'confirmed' | 'rolled_back';
    id: string;
  }>;
  /** 保存新版本，返回版本 ID */
  saveVersion(params: {
    assistantId: PermanentId;
    promptContent: string;
    baselineScore: number;
    changeSummary: string;
  }): Promise<{ id: string }>;
  /** 更新版本状态 */
  updateVersionStatus(
    evolutionId: string,
    status: 'pending' | 'validating' | 'confirmed' | 'rolled_back'
  ): Promise<void>;
};

/**
 * openMaic：OpenMaic 会议室（提交审议议题）
 */
declare const openMaic: {
  submitAgenda(agenda: {
    topic: string;
    context: Record<string, unknown>;
    urgency: 'low' | 'normal' | 'high' | 'emergency';
    initiator: string;
  }): void;
};

/**
 * supabase：读取助手性能日志
 */
declare const supabase: {
  from(table: string): {
    select(cols?: string): {
      eq(
        col: string,
        val: string
      ): {
        order(
          col: string,
          opts?: { ascending: boolean }
        ): {
          limit(n: number): Promise<{
            data: unknown[] | null;
            error: unknown | null;
          }>;
        };
      };
    };
  };
};

/**
 * avatarSystem：进化后同步所有客制助手
 */
declare const avatarSystem: AvatarSystem;

// ─── EvolutionLoop ────────────────────────────────────────────────────────────

export class EvolutionLoop {
  /** 进化周期 1 小时 */
  readonly CHECK_INTERVAL = 60 * 60 * 1000;
  /** 评分取样窗口 20 条 */
  readonly SCORE_WINDOW = 20;
  /** 进化触发阈值：均分 < 0.6 → 需要进化 */
  readonly THRESHOLD = 0.6;
  /** 自动进化置信度门槛 */
  readonly AUTO_EVOLVE_CONFIDENCE = 0.7;
  /** 验证样本窗口 50 条 */
  readonly VALIDATION_WINDOW = 50;
  /** 回滚触发 delta（均分下降超 10%） */
  readonly ROLLBACK_DELTA = -0.1;

  private cycleTimer: ReturnType<typeof setInterval> | null = null;

  // ─── 启动 / 停止 ──────────────────────────────────────────────────────────

  /**
   * 启动自进化循环（每 1 小时触发一次 runCycle）。
   */
  async start(): Promise<void> {
    console.log(
      `[EvolutionLoop] 自进化循环已启动，周期 ${this.CHECK_INTERVAL / 1000 / 60} min`
    );

    this.cycleTimer = setInterval(() => {
      this.runCycle().catch((err: unknown) => {
        console.error('[EvolutionLoop] runCycle unhandled error:', err);
      });
    }, this.CHECK_INTERVAL);
  }

  /**
   * 停止循环（测试 / 优雅关闭用）。
   */
  stop(): void {
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  // ─── 核心周期 ─────────────────────────────────────────────────────────────

  /**
   * 一次完整进化周期：对每个永久助手依次执行评估 → 进化。
   */
  private async runCycle(): Promise<void> {
    console.log(`[EvolutionLoop] runCycle @ ${new Date().toISOString()}`);

    for (const aid of PERMANENT_ASSISTANTS) {
      try {
        const evalResult = await this.evaluate(aid);
        if (evalResult !== null) {
          await this.evolve(evalResult);
        }
      } catch (err: unknown) {
        console.error(`[EvolutionLoop] cycle error for ${aid}:`, err);
      }
    }
  }

  // ─── 评分 ─────────────────────────────────────────────────────────────────

  /**
   * 对单条任务信号打分（baseline 0.5，clamp [0, 1]）：
   *  - latency < 3s:     +0.2
   *  - latency > 30s:    -0.2
   *  - resolved:         +0.2
   *  - failed:           -0.3
   *  - handed_back:      -0.1
   *  - thumbs_up:        +0.3
   *  - thumbs_down:      -0.3
   */
  private scoreTask(signal: TaskSignal): number {
    let score = 0.5;

    // 延迟
    if (signal.latencyMs < 3_000) {
      score += 0.2;
    } else if (signal.latencyMs > 30_000) {
      score -= 0.2;
    }

    // 结果
    if (signal.resolved)   score += 0.2;
    if (signal.failed)     score -= 0.3;
    if (signal.handedBack) score -= 0.1;

    // 用户反馈
    if (signal.feedback === 'thumbs_up')   score += 0.3;
    if (signal.feedback === 'thumbs_down') score -= 0.3;

    return Math.max(0, Math.min(1, score));
  }

  // ─── 评估 ─────────────────────────────────────────────────────────────────

  /**
   * 评估某助手近期表现：
   *  1. 从 agent_performance_log 取近 SCORE_WINDOW 条
   *  2. 计算均分；avgScore >= THRESHOLD → return null（不需要进化）
   *  3. 委托 duck-lee 做根因分析（不自己调模型）
   *  4. 返回 EvalResult
   */
  private async evaluate(
    assistantId: PermanentId
  ): Promise<EvalResult | null> {
    const { data, error } = await supabase
      .from('agent_performance_log')
      .select()
      .eq('assistant_id', assistantId)
      .order('created_at', { ascending: false })
      .limit(this.SCORE_WINDOW);

    if (error) {
      console.error(
        `[EvolutionLoop] evaluate DB error for ${assistantId}:`,
        error
      );
      return null;
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null; // 无数据，跳过

    const signals: TaskSignal[] = rows.map((row) => ({
      taskId: String(row['task_id'] ?? ''),
      assistantId,
      latencyMs: Number(row['latency_ms'] ?? 0),
      resolved: Boolean(row['resolved']),
      failed: Boolean(row['failed']),
      handedBack: Boolean(row['handed_back']),
      feedback: row['feedback'] as TaskSignal['feedback'],
    }));

    const avgScore =
      signals.reduce((sum, s) => sum + this.scoreTask(s), 0) / signals.length;

    if (avgScore >= this.THRESHOLD) return null; // 表现正常，无需进化

    console.log(
      `[EvolutionLoop] ${assistantId} 均分 ${avgScore.toFixed(3)} < ${this.THRESHOLD}，` +
        `委托 duck-lee 做根因分析`
    );

    // 委托 duck-lee 做根因分析（宪章：不自己调模型）
    const analysisResponse = await delegate('duck-lee', {
      type: 'root_cause_analysis',
      assistantId,
      avgScore,
      recentSignals: signals,
    });

    const analysis =
      typeof analysisResponse === 'string'
        ? analysisResponse
        : JSON.stringify(analysisResponse);

    return {
      assistantId,
      avgScore,
      analysis,
      suggestionSource: 'duck-lee',
    };
  }

  // ─── 进化 ─────────────────────────────────────────────────────────────────

  /**
   * 根据评估结果执行进化：
   *  1. 从 factoryRegistry 取当前版本 Prompt
   *  2. 委托 forty-cents 生成新版 Prompt（不自己调模型）
   *  3. parse { new_prompt, change_summary, confidence }
   *  4a. confidence >= AUTO_EVOLVE_CONFIDENCE → 热更新 + syncAvatars + 异步验证
   *  4b. confidence < 阈值 → 提交 OpenMaic 会议议题审议
   */
  private async evolve(result: EvalResult): Promise<void> {
    const { assistantId, avgScore, analysis } = result;

    // 1. 取当前稳定版本
    const currentVersion = await factoryRegistry.getLastStable(assistantId);

    // 2. 委托 forty-cents 生成新版 Prompt
    const promptResponse = await delegate('forty-cents', {
      type: 'generate_evolved_prompt',
      assistantId,
      currentPrompt: currentVersion.content,
      analysis,
      avgScore,
    });

    const { new_prompt, change_summary, confidence } =
      promptResponse as {
        new_prompt: string;
        change_summary: string;
        confidence: number;
      };

    // 3. 保存新版本到 factoryRegistry
    const { id: evolutionId } = await factoryRegistry.saveVersion({
      assistantId,
      promptContent: new_prompt,
      baselineScore: avgScore,
      changeSummary: change_summary,
    });

    if (confidence >= this.AUTO_EVOLVE_CONFIDENCE) {
      // 4a. 自动热更新
      clawbot.hotUpdate(assistantId, { systemPrompt: new_prompt });
      await factoryRegistry.updateVersionStatus(evolutionId, 'validating');

      // 同步所有客制助手 avatars（跟随基座版本更新）
      await avatarSystem.syncOnEvolution(assistantId, evolutionId);

      console.log(
        `[EvolutionLoop] ✅ ${assistantId} 自动进化完成 ` +
          `(confidence=${confidence.toFixed(2)}, evolutionId=${evolutionId})`
      );

      // 异步验证，不阻塞本周期
      this.validate(evolutionId).catch((err: unknown) => {
        console.error(
          `[EvolutionLoop] validate(${evolutionId}) error:`,
          err
        );
      });
    } else {
      // 4b. 置信度不足，提交 OpenMaic 审议，不自动上线
      openMaic.submitAgenda({
        topic: `${assistantId} 进化提案审议`,
        context: {
          evolutionId,
          assistantId,
          avgScore,
          confidence,
          changeSummary: change_summary,
          analysis,
        },
        urgency: 'normal',
        initiator: 'evolution-loop',
      });

      console.log(
        `[EvolutionLoop] 📋 ${assistantId} 进化提案已提交 OpenMaic 审议 ` +
          `(confidence=${confidence.toFixed(2)} < ${this.AUTO_EVOLVE_CONFIDENCE})`
      );
    }
  }

  // ─── 验证 ─────────────────────────────────────────────────────────────────

  /**
   * 验证进化效果（在 evolve 完成后异步调用）：
   *  1. 数据 < VALIDATION_WINDOW → return，等待足够样本
   *  2. delta < ROLLBACK_DELTA → 回滚至上一稳定版本
   *  3. else → status = 'confirmed'
   */
  private async validate(evolutionId: string): Promise<void> {
    const versionInfo = await factoryRegistry.getVersion(evolutionId);
    const { assistantId, baselineScore } = versionInfo;

    const { data, error } = await supabase
      .from('agent_performance_log')
      .select()
      .eq('assistant_id', assistantId)
      .order('created_at', { ascending: false })
      .limit(this.VALIDATION_WINDOW);

    if (error) {
      console.error(`[EvolutionLoop] validate DB error (${evolutionId}):`, error);
      return;
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // 样本不足，等待
    if (rows.length < this.VALIDATION_WINDOW) {
      console.log(
        `[EvolutionLoop] validate ${evolutionId}: ` +
          `仅 ${rows.length}/${this.VALIDATION_WINDOW} 条，等待更多数据`
      );
      return;
    }

    const signals: TaskSignal[] = rows.map((row) => ({
      taskId: String(row['task_id'] ?? ''),
      assistantId,
      latencyMs: Number(row['latency_ms'] ?? 0),
      resolved: Boolean(row['resolved']),
      failed: Boolean(row['failed']),
      handedBack: Boolean(row['handed_back']),
      feedback: row['feedback'] as TaskSignal['feedback'],
    }));

    const postScore =
      signals.reduce((sum, s) => sum + this.scoreTask(s), 0) / signals.length;

    const delta = postScore - baselineScore;

    if (delta < this.ROLLBACK_DELTA) {
      // 回滚
      const stableVersion = await factoryRegistry.getLastStable(assistantId);
      clawbot.hotUpdate(assistantId, { systemPrompt: stableVersion.content });
      await factoryRegistry.updateVersionStatus(evolutionId, 'rolled_back');

      console.log(
        `[EvolutionLoop] ⏪ ${assistantId} 进化已回滚 ` +
          `(delta=${delta.toFixed(3)} < ${this.ROLLBACK_DELTA}, evolutionId=${evolutionId})`
      );
    } else {
      // 确认
      await factoryRegistry.updateVersionStatus(evolutionId, 'confirmed');

      console.log(
        `[EvolutionLoop] ✅ ${assistantId} 进化验证通过 ` +
          `(delta=+${delta.toFixed(3)}, postScore=${postScore.toFixed(3)}, evolutionId=${evolutionId})`
      );
    }
  }
}
