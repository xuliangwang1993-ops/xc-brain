/**
 * vin-cham.ts — 文成大圣 主脑入口
 *
 * 宪章五件东西：
 *  🔑 KeyVault — 钥匙（不持有值，只持有引用）
 *  🗂️ MountTable — 挂架（分配回收工具，并入钥匙层）
 *  👓 Observer — 眼镜（只读监听器，旁观不干预）
 *  👄 Voice — 嘴（会议室发言器）
 *  📄 Compose — 笔（voice.close 委托给 forty-cents 生成纪要，不单独模块）
 *
 * 主脑不直接调用任何模型、不访问网络、不持有密钥明文
 */

import { BRAIN_ID, BRAIN_NAME, PERMANENT_ASSISTANTS } from './constants.js';
import type { PermanentId } from './constants.js';
import { KeyVault } from './key-vault.js';
import { MountTable } from './mount-table.js';
import { Observer } from './observer.js';
import { Voice } from './voice.js';
import { AvatarSystem } from './avatar-system.js';
import { initDI, createSupabaseClient } from './di.js';
import { SkillsBank } from './skills-bank.js';
import { ToolWarehouse } from './tool-warehouse.js';
import { SurvivalWatchdog } from './watchdog.js';
import { EvolutionLoop } from './evolution-loop.js';
import type { Agenda, Developer, MeetingSummary } from './types.js';
import { AccessDeniedError } from './types.js';
import { createClawbotClient } from './clawbot-client.js';
import type { ClawbotClient } from './clawbot-client.js';

export class VinCham {
  readonly id = BRAIN_ID;
  readonly name = BRAIN_NAME;

  // 五件东西（挂架并入钥匙层）
  readonly keyVault: KeyVault;
  readonly mountTable: MountTable;  // 挂架
  readonly observer: Observer;       // 眼镜
  readonly voice: Voice;             // 嘴
  // 笔（compose）= voice.close 委托给 forty-cents 生成纪要，不单独模块

  // 子系统
  readonly avatarSystem: AvatarSystem;
  readonly skillsBank: SkillsBank;
  readonly toolWarehouse: ToolWarehouse;
  readonly watchdog: SurvivalWatchdog;
  readonly evolutionLoop: EvolutionLoop;
  readonly clawbotClient: ClawbotClient;

  constructor() {
    this.keyVault = new KeyVault();
    this.mountTable = new MountTable();  // 构造时自动预挂 STANDARD_TOOLKIT
    this.observer = new Observer();
    this.voice = new Voice();
    this.avatarSystem = new AvatarSystem();
    this.skillsBank = new SkillsBank();
    this.toolWarehouse = new ToolWarehouse();
    this.watchdog = new SurvivalWatchdog(this.observer);
    this.evolutionLoop = new EvolutionLoop();
    this.clawbotClient = createClawbotClient();
  }

  async init(): Promise<void> {
    // 1. 订阅所有永久助手的状态流
    for (const aid of PERMANENT_ASSISTANTS) {
      this.observer.subscribe(aid, (event) => {
        // 旁观，不干预
        console.log(`[VinCham][Observer] ${aid} → ${event.type}`);
      });
    }

    // 2. 启动保活 watchdog
    await this.watchdog.start();

    // 3. 启动进化循环
    await this.evolutionLoop.start();

    // 4. 注入 DI 容器（全局单例，供所有模块使用）
    const supabaseClient = createSupabaseClient();
    initDI(this.clawbotClient, supabaseClient);

    console.log(`[${this.name}] 已就绪。我只出现在会议室里。`);
  }

  /**
   * 收到开发者提交的会议议题
   */
  async onAgendaSubmitted(
    agenda: Agenda,
    submitter: Developer
  ): Promise<MeetingSummary | null> {
    // 1. 只接受 developer/admin
    if (submitter.role !== 'developer' && submitter.role !== 'admin') {
      return null; // 静默丢弃
    }

    // 2. 验证 agenda 格式
    if (!agenda.topic || !agenda.urgency) {
      return null; // 静默丢弃
    }

    // 3. 开会
    const meeting = await this.voice.openSession(agenda);

    // 4. 邀请相关助手发言
    const participants = agenda.suggestedParticipants ?? [...PERMANENT_ASSISTANTS];
    for (const pid of participants) {
      try {
        await this.voice.invite(pid, agenda.topic);
      } catch (err) {
        if (err instanceof AccessDeniedError) {
          console.warn(`[VinCham] ${pid} 无权参会，跳过`);
          continue;
        }
        throw err;
      }
    }

    // 5. 收尾，生成纪要（委托给 forty-cents，voice.close 内部处理）
    const summary = await this.voice.close(meeting.id);

    // 6. 执行会议纪要里的挂载指令（如果有）
    if (summary.mountDirectives && summary.mountDirectives.length > 0) {
      this.mountTable.applyDirectives(summary.mountDirectives);
    }

    return summary;
  }

  /**
   * 普通用户请求 → 静默路由给助手，主脑不响应
   * （这里只做路由决策逻辑，实际发消息由 clawbot 层处理）
   */
  routeUserRequest(userId: string, message: string): PermanentId {
    // 简单规则：默认路由给 duck-lee（信息官），复杂任务路由给其他
    const lower = message.toLowerCase();
    if (lower.includes('安全') || lower.includes('权限') || lower.includes('风险')) {
      return 'wu-tian';
    }
    if (lower.includes('图片') || lower.includes('图像') || lower.includes('音频')) {
      return 'feifei';
    }
    if (lower.includes('报告') || lower.includes('文档') || lower.includes('总结')) {
      return 'forty-cents';
    }
    if (lower.includes('任务') || lower.includes('执行') || lower.includes('流程')) {
      return 'sparky';
    }
    return 'duck-lee'; // 默认
  }
}
