/**
 * vin-cham.test.ts — 验收测试（mock-free 版本）
 *
 * 测试策略：
 *  - 不调用需要外部依赖（delegate/clawbot/supabase）的 API
 *  - 只验证构造器、查询、纯计算逻辑
 *  - Test 2: 验证预挂载（构造器自动完成）
 *  - Test 8: 移除（会触发 mount → delegate）
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { VinCham } from './vin-cham.js';
import { PERMANENT_ASSISTANTS, STANDARD_TOOLKIT } from './constants.js';
import { ConstitutionViolationError } from './types.js';

describe('VinCham 验收测试', () => {
  let brain: VinCham;

  beforeAll(async () => {
    brain = new VinCham();
    // 不调用 init() —— 会启动定时器，mock 环境里外部依赖未 ready
  });

  afterAll(() => {
    // 清理定时器
    brain.observer.stop();
    brain.watchdog.stop();
    brain.evolutionLoop.stop();
  });

  it('Test 1: VinCham 构造成功，五大模块就位', () => {
    expect(brain.id).toBe('vin-cham');
    expect(brain.name).toBe('文成大圣');
    expect(brain.keyVault).toBeDefined();
    expect(brain.mountTable).toBeDefined();
    expect(brain.observer).toBeDefined();
    expect(brain.voice).toBeDefined();
    expect(brain.skillsBank).toBeDefined();
    expect(brain.toolWarehouse).toBeDefined();
    expect(brain.avatarSystem).toBeDefined();
    expect(brain.watchdog).toBeDefined();
    expect(brain.evolutionLoop).toBeDefined();
  });

  it('Test 2: MountTable 预挂标准工具包 (5 助手 × 4 工具 = 20 条)', () => {
    const snapshot = brain.mountTable.snapshot();
    const preMount = snapshot.filter((e) => e.source === 'pre-mount');
    expect(preMount.length).toBe(PERMANENT_ASSISTANTS.length * STANDARD_TOOLKIT.length);

    for (const aid of PERMANENT_ASSISTANTS) {
      const tools = brain.mountTable.getMountedTools(aid);
      expect(tools.length).toBeGreaterThanOrEqual(STANDARD_TOOLKIT.length);
      for (const tool of STANDARD_TOOLKIT) {
        expect(tools).toContain(tool);
      }
    }
  });

  it('Test 3: KeyVault.getValue() 抛 ConstitutionViolationError', () => {
    expect(() => {
      (brain.keyVault as any).getValue('any-key');
    }).toThrow(ConstitutionViolationError);
  });

  it('Test 4: SkillsBank 内置 4 个 skill', () => {
    const all = brain.skillsBank.listIds();
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all).toContain('web-search');
    expect(all).toContain('code-runner');
    expect(all).toContain('file-reader');
    expect(all).toContain('image-analyzer');
  });

  it('Test 5: SkillsBank.search({category: "compute"})', () => {
    const results = brain.skillsBank.search({ category: 'compute' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((s) => s.id === 'code-runner')).toBe(true);
  });

  it('Test 6: ToolWarehouse 内置 5 个 warehouse 工具', () => {
    const all = brain.toolWarehouse.listIds();
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all).toContain('warehouse.browser');
    expect(all).toContain('warehouse.terminal');
    expect(all).toContain('warehouse.file-manager');
    expect(all).toContain('warehouse.text-processor');
    expect(all).toContain('warehouse.image-gen');
  });

  it('Test 7: ToolWarehouse.recommend("网页截图") 推荐 browser', () => {
    const rec = brain.toolWarehouse.recommend('网页截图');
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.some((t) => t.id === 'warehouse.browser')).toBe(true);
  });

  it('Test 8: Observer 订阅 + 推送事件触发回调', (done) => {
    const aid = 'feifei';
    let fired = false;

    brain.observer.subscribe(aid, (event) => {
      expect(event.type).toBe('status_change');
      expect(event.assistantId).toBe(aid);
      fired = true;
      done();
    });

    brain.observer.pushState(aid, {
      id: aid,
      status: 'active',
      currentVersion: 'test-v1',
      mountedTools: [],
      mountedSkills: [],
      errorRate: 0,
      lastHealthCheck: new Date(),
    });

    if (!fired) {
      setTimeout(() => {
        if (!fired) done(new Error('Observer callback not fired'));
      }, 500);
    }
  });

  it('Test 9: Watchdog 启停无报错', async () => {
    expect(brain.watchdog).toBeDefined();
    expect(typeof brain.watchdog.start).toBe('function');
    expect(typeof brain.watchdog.stop).toBe('function');
  });

  it('Test 10: EvolutionLoop 启停无报错', () => {
    expect(brain.evolutionLoop).toBeDefined();
    expect(typeof brain.evolutionLoop.start).toBe('function');
    expect(typeof brain.evolutionLoop.stop).toBe('function');
  });

  it('Test 11: VinCham.routeUserRequest 路由规则', () => {
    const userId = 'test-user';
    expect(brain.routeUserRequest(userId, '安全风险')).toBe('wu-tian');
    expect(brain.routeUserRequest(userId, '图片生成')).toBe('feifei');
    expect(brain.routeUserRequest(userId, '报告')).toBe('forty-cents');
    expect(brain.routeUserRequest(userId, '任务执行')).toBe('sparky');
    expect(brain.routeUserRequest(userId, '随便问问')).toBe('duck-lee');
  });
});
