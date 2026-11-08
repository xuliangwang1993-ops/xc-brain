/**
 * clawbot-client.ts — Clawbot JSON-RPC 2.0 HTTP 客户端
 *
 * 连接到远程 Clawbot 服务（http://45.32.191.98:3100/rpc）
 * 所有 6 个 RPC 方法 + 健康检查
 */

/**
 * JSON-RPC 2.0 请求体
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: any;
  id: number;
}

/**
 * JSON-RPC 2.0 响应体
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number;
}

/**
 * Clawbot 客户端
 */
export class ClawbotClient {
  private baseUrl: string;
  private token: string;
  private idCounter: number = 0;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * 发送 JSON-RPC 请求的底层方法
   */
  private async call(method: string, params: any): Promise<any> {
    const id = ++this.idCounter;
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 秒超时

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: JsonRpcResponse = await response.json();

      // JSON-RPC 2.0 错误处理
      if (data.error) {
        const err = new Error(data.error.message) as any;
        err.code = data.error.code;
        err.data = data.error.data;
        throw err;
      }

      return data.result;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Clawbot 请求超时（30 秒）');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 代理任务给指定助手
   */
  async delegate(params: {
    task: string;
    assistant: string;
    context?: any;
  }): Promise<any> {
    return this.call('delegate', params);
  }

  /**
   * Clawbot 通用方法调用
   */
  async clawbot(params: {
    method: string;
    params: any;
  }): Promise<any> {
    return this.call('clawbot', params);
  }

  /**
   * 工厂注册表操作
   */
  async factoryRegistry(params: {
    operation: string;
    filters?: any;
  }): Promise<any> {
    return this.call('factoryRegistry', params);
  }

  /**
   * OpenMAIC 会议室操作
   */
  async openMaic(params: {
    method: string;
    meetingId?: string;
    participants?: string[];
    message?: string;
  }): Promise<any> {
    return this.call('openMaic', params);
  }

  /**
   * Supabase 数据库操作
   */
  async supabase(params: {
    table: string;
    operation: string;
    filters?: any;
    data?: any;
  }): Promise<any> {
    return this.call('supabase', params);
  }

  /**
   * Avatar 管理操作
   */
  async avatarManagement(params: {
    operation: string;
    slotId?: string;
    config?: any;
  }): Promise<any> {
    return this.call('avatarManagement', params);
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 健康检查 5 秒超时

    try {
      const healthUrl = this.baseUrl.replace('/rpc', '/health');
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (err) {
      clearTimeout(timeoutId);
      return false;
    }
  }
}

/**
 * 单例工厂
 * 从环境变量 CLAWBOT_BEARER_TOKEN 读取 token
 */
export function createClawbotClient(): ClawbotClient {
  const baseUrl = 'http://45.32.191.98:3100/rpc';
  const token = process.env.CLAWBOT_BEARER_TOKEN ?? '';

  if (!token) {
    throw new Error('环境变量 CLAWBOT_BEARER_TOKEN 未设置');
  }

  return new ClawbotClient(baseUrl, token);
}
