/**
 * di.ts - Dependency Injection container for xc-brain
 * 
 * Provides global access to ClawbotClient and Supabase client instances.
 * Must be initialized once via initDI() before any module uses getClient() or getSupabase().
 */
import type { ClawbotClient } from './clawbot-client.js'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PermanentId } from './constants.js'

let _client: ClawbotClient | null = null
let _supabase: SupabaseClient<any> | null = null

/**
 * Initialize the DI container with global instances.
 * Call this once during application startup.
 */
export function initDI(client: ClawbotClient, supabase: SupabaseClient<any>): void {
  _client = client
  _supabase = supabase
}

/**
 * Get the ClawbotClient instance.
 * @throws Error if initDI() has not been called
 */
export function getClient(): ClawbotClient {
  if (!_client) throw new Error('[DI] ClawbotClient not initialized. Call initDI() first.')
  return _client
}

/**
 * Get the Supabase client instance.
 * @throws Error if initDI() has not been called
 */
export function getSupabase(): SupabaseClient<any> {
  if (!_supabase) throw new Error('[DI] Supabase client not initialized. Call initDI() first.')
  return _supabase
}

/**
 * Delegate a task to an assistant via ClawbotClient.
 */
export async function delegate(assistantId: PermanentId, task: unknown): Promise<unknown> {
  const client = getClient()
  return await client.delegate({ assistant: assistantId as string, task: task as string })
}

/**
 * Execute a Supabase query via the global client.
 */
export async function supabaseQuery(
  table: string,
  op: string,
  params?: Record<string, any>
): Promise<unknown> {
  const sb = getSupabase()
  const query = sb.from(table)
  // Simplified: extend this with actual query builder logic as needed
  return await (query as any)[op](params)
}

/**
 * Create a fresh Supabase client from environment variables.
 * Useful for one-off initialization or testing.
 */
export function createSupabaseClient(): SupabaseClient<any> {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('[DI] SUPABASE_URL or SUPABASE_SERVICE_KEY not set in environment')
  }
  return createClient(url, key)
}
