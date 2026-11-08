/**
 * voice.ts — 会议室发言器 (Voice)
 *
 * 宪章约束（不可绕过）：
 *  1. Voice 内部不得直接调用任何模型
 *  2. 综合总结通过 delegate('forty-cents', ...) 完成，主脑自己不生成
 *  3. 客制助手可进会议（CUSTOM_NAKED），但 stripTools=true，发言时工具不可用
 *  4. 非 PERMANENT_ASSISTANTS 且非客制助手 → throw AccessDeniedError
 */

import { PERMANENT_ASSISTANTS, BRAIN_ID, BRAIN_NAME, MEETING_ROLES } from './constants.js';
import type { PermanentId } from './constants.js';
import type { Agenda, Meeting, MeetingSummary, Statement, ActionItem } from './types.js';
import { AccessDeniedError } from './types.js';

// ─── External interfaces (not implemented here) ───────────────────────────────

/** 将任务委派给指定永久助手（主脑的唯一对外调用路径） */
declare function delegate(assistantId: PermanentId, task: unknown): Promise<unknown>;

/** 挂载表：获取某永久助手当前已挂载的工具列表 */
declare const mountTable: { getMountedTools(id: PermanentId): string[] };

/** 客制助手注册表（AvatarSystem 的实例），Voice 用来查询 isCustom */
declare const customAssistantRegistry: import('./avatar-system.js').AvatarSystem;

/** Supabase 客户端（主脑层统一提供） */
declare const supabase: {
  from(table: string): {
    insert(row: unknown): Promise<{ error: unknown | null }>;
    update(values: unknown): { eq(col: string, val: string): Promise<{ error: unknown | null }> };
  };
};

// ─── Voice ────────────────────────────────────────────────────────────────────

export class Voice {
  /**
   * 开场：宣布议题，确认参与者，生成 Meeting 记录。
   * 参与者名单取自 agenda.suggestedParticipants，逐一用
   * assertCanParticipate 过滤（非法身份直接排除并记录警告）。
   */
  async openSession(agenda: Agenda): Promise<Meeting> {
    const meetingId = `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 验证并收集合法参会者
    const participants: PermanentId[] = [];
    for (const id of agenda.suggestedParticipants ?? []) {
      try {
        this.assertCanParticipate(id);
        // assertCanParticipate 通过 → 永久助手或客制助手；永久助手才进 participants 主列
        if ((PERMANENT_ASSISTANTS as readonly string[]).includes(id)) {
          participants.push(id as PermanentId);
        }
      } catch {
        console.warn(`[Voice] 参会者 ${id} 未通过验证，已跳过`);
      }
    }

    const openingLine = this.phrases.opening(agenda.topic);

    const meeting: Meeting = {
      id: meetingId,
      topic: agenda.topic,
      participants,
      status: 'open',
      transcript: [
        {
          speaker: BRAIN_ID,
          content: openingLine,
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
    };

    // 持久化到 Supabase meetings 表
    await supabase.from('meetings').insert({
      id: meeting.id,
      topic: meeting.topic,
      participants: JSON.stringify(participants),
      status: meeting.status,
      transcript: JSON.stringify(meeting.transcript),
      created_at: meeting.createdAt.toISOString(),
    });

    return meeting;
  }

  /**
   * 邀请发言。
   *
   * 访问规则（宪章级，不可修改）：
   *  - PermanentId → 正常邀请，带完整工具包发言
   *  - CustomAssistant（custom_naked）→ 允许进入，但 stripTools=true
   *  - 其他任何 ID → throw AccessDeniedError
   *
   * Voice 本身不调用模型；发言内容通过 delegate 路由给对应永久助手，
   * 客制助手则 delegate 给其 baseAssistant（stripTools 标记由 baseAssistant 执行层遵守）。
   */
  async invite(
    participantId: PermanentId | string,
    question: string
  ): Promise<Statement> {
    const role = this.assertCanParticipate(participantId);
    const stripTools = role === 'custom_naked';

    // 确定实际接收 delegate 的助手 ID
    let delegateTarget: PermanentId;
    let speakerLabel: string;

    if (role === 'permanent') {
      delegateTarget = participantId as PermanentId;
      speakerLabel = participantId;
    } else {
      // custom_naked：向其 baseAssistant delegate，标注 stripTools
      const avatar = await customAssistantRegistry.getById(participantId);
      delegateTarget = avatar.baseAssistant;
      speakerLabel = participantId; // Statement 里显示客制助手自己的 ID
    }

    const invitePhrase = this.phrases.invite(speakerLabel, question);

    // delegate 给目标助手；payload 包含 stripTools 标记
    const response = await delegate(delegateTarget, {
      type: 'meeting_question',
      question,
      invitePhrase,
      speakingAs: participantId,   // 客制助手时携带原始 ID，让 baseAssistant 知道身份
      stripTools,                   // 宪章：客制助手发言时工具不可用
    });

    const statement: Statement = {
      speaker: participantId as PermanentId, // 类型断言：Statement.speaker 含客制助手 ID
      content: typeof response === 'string' ? response : JSON.stringify(response),
      timestamp: new Date(),
    };

    return statement;
  }

  /**
   * 收尾：生成综合总结，写入 Supabase。
   *
   * 宪章：总结必须 delegate 给 forty-cents（四毛），主脑不自行生成内容。
   */
  async close(meetingId: string): Promise<MeetingSummary> {
    // 1. 从 Supabase 取回会议记录（此处通过 delegate 给 forty-cents 完成汇总，主脑不直接调模型）
    const summaryResponse = await delegate('forty-cents', {
      type: 'meeting_summary',
      meetingId,
    });

    // 2. 解析 forty-cents 返回的结构
    const raw = summaryResponse as {
      decisions?: string[];
      actionItems?: ActionItem[];
      mountDirectives?: import('./types.js').MountDirective[];
    };

    const summary: MeetingSummary = {
      meetingId,
      topic: '', // 主脑不重建 topic，forty-cents 应在 decisions[0] 里说明
      decisions: raw.decisions ?? [],
      actionItems: raw.actionItems ?? [],
      archivedAt: new Date(),
      mountDirectives: raw.mountDirectives,
    };

    const closingLine = this.phrases.closing(summary.decisions.join('；'));

    // 3. 写入 Supabase meeting_summaries 表
    await supabase.from('meeting_summaries').insert({
      meeting_id: meetingId,
      decisions: JSON.stringify(summary.decisions),
      action_items: JSON.stringify(summary.actionItems),
      archived_at: summary.archivedAt.toISOString(),
      closing_statement: closingLine,
      mount_directives: JSON.stringify(summary.mountDirectives ?? []),
    });

    // 4. 将对应 meetings 行标记为 archived
    await supabase
      .from('meetings')
      .update({ status: 'archived' })
      .eq('id', meetingId);

    return summary;
  }

  // ─── 内部：准入验证 ──────────────────────────────────────────────────────────

  /**
   * 验证 ID 是否可参会。
   * 返回值：
   *  - 'permanent'    → PERMANENT_ASSISTANTS 成员，带工具包
   *  - 'custom_naked' → 已注册的客制助手，裸进
   * 否则 → throw AccessDeniedError
   */
  private assertCanParticipate(id: string): 'permanent' | 'custom_naked' {
    if ((PERMANENT_ASSISTANTS as readonly string[]).includes(id)) {
      return 'permanent';
    }
    if (customAssistantRegistry.isCustom(id)) {
      return 'custom_naked';
    }
    throw new AccessDeniedError(
      `${id} 不是合法参会者：既不在 PERMANENT_ASSISTANTS 名单内，也未在客制助手注册表中登记`
    );
  }

  // ─── 内部：发言短语 ──────────────────────────────────────────────────────────

  /** 文成大圣的固定台词库（主脑唯一有发言权的场景：开场 / 邀请 / 收尾） */
  private readonly phrases = {
    /** 开场台词 */
    opening: (topic: string) =>
      `诸位好，我是${BRAIN_NAME}。今天我们来讨论：${topic}。`,

    /** 邀请某参会者发言 */
    invite: (name: string, q: string) =>
      `请${name}分享你对「${q}」的判断。`,

    /** 收尾综合总结（内容由 forty-cents 生成，此处仅包裹台词格式） */
    closing: (summary: string) =>
      `综合各位的意见，我总结如下：${summary}`,
  } as const;
}
