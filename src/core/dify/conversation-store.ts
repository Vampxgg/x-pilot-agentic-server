// src/core/dify/conversation-store.ts
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { logger } from "../../utils/logger.js";

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

export interface ConversationRecord {
  id: string;
  name: string;
  inputs: Record<string, unknown>;
  status: "normal" | "archived";
  introduction: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  parent_message_id: string;
  inputs: Record<string, unknown>;
  query: string;
  answer: string;
  feedback: null;
  retriever_resources: unknown[];
  created_at: number;
  agent_thoughts: unknown[];
  message_files: unknown[];
  status: "normal" | "error";
  error: string | null;
}

export class ConversationStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_DATA_DIR;
  }

  private convDir(tenantId: string, userId: string): string {
    return join(this.baseDir, "tenants", tenantId, "users", userId, "conversations");
  }

  private indexPath(tenantId: string, userId: string): string {
    return join(this.convDir(tenantId, userId), "index.json");
  }

  private messagesPath(tenantId: string, userId: string, conversationId: string): string {
    return join(this.convDir(tenantId, userId), conversationId, "messages.json");
  }

  // --- Read/write helpers ---

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    if (!existsSync(filePath)) return fallback;
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // --- Conversation operations ---

  async listConversations(tenantId: string, userId: string, opts?: {
    limit?: number; firstId?: string;
  }): Promise<{ data: ConversationRecord[]; has_more: boolean; limit: number }> {
    const all = await this.readJson<ConversationRecord[]>(this.indexPath(tenantId, userId), []);
    // Sort by created_at desc (newest first)
    all.sort((a, b) => b.created_at - a.created_at);

    const limit = opts?.limit ?? 20;
    let startIdx = 0;

    if (opts?.firstId) {
      const idx = all.findIndex(c => c.id === opts.firstId);
      if (idx >= 0) startIdx = idx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit);
    return {
      data: page,
      has_more: startIdx + limit < all.length,
      limit,
    };
  }

  async getOrCreateConversation(tenantId: string, userId: string, sessionId: string, meta: {
    name: string; inputs: Record<string, unknown>;
  }): Promise<ConversationRecord> {
    const all = await this.readJson<ConversationRecord[]>(this.indexPath(tenantId, userId), []);
    const existing = all.find(c => c.id === sessionId);
    if (existing) {
      existing.updated_at = Math.floor(Date.now() / 1000);
      await this.writeJson(this.indexPath(tenantId, userId), all);
      return existing;
    }

    const now = Math.floor(Date.now() / 1000);
    const record: ConversationRecord = {
      id: sessionId,
      name: meta.name,
      inputs: meta.inputs,
      status: "normal",
      introduction: "",
      created_at: now,
      updated_at: now,
    };
    all.push(record);
    await this.writeJson(this.indexPath(tenantId, userId), all);
    logger.info(`[ConversationStore] Created conversation: ${sessionId}`);
    return record;
  }

  async deleteConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> {
    const all = await this.readJson<ConversationRecord[]>(this.indexPath(tenantId, userId), []);
    const idx = all.findIndex(c => c.id === conversationId);
    if (idx < 0) return false;

    all.splice(idx, 1);
    await this.writeJson(this.indexPath(tenantId, userId), all);

    // Remove messages directory
    const msgDir = join(this.convDir(tenantId, userId), conversationId);
    if (existsSync(msgDir)) {
      await rm(msgDir, { recursive: true });
    }

    logger.info(`[ConversationStore] Deleted conversation: ${conversationId}`);
    return true;
  }

  // --- Message operations ---

  async listMessages(tenantId: string, userId: string, conversationId: string, opts?: {
    limit?: number; firstId?: string;
  }): Promise<{ data: MessageRecord[]; has_more: boolean; limit: number }> {
    const all = await this.readJson<MessageRecord[]>(
      this.messagesPath(tenantId, userId, conversationId), []
    );
    all.sort((a, b) => b.created_at - a.created_at);

    const limit = opts?.limit ?? 20;
    let startIdx = 0;

    if (opts?.firstId) {
      const idx = all.findIndex(m => m.id === opts.firstId);
      if (idx >= 0) startIdx = idx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit);
    return {
      data: page,
      has_more: startIdx + limit < all.length,
      limit,
    };
  }

  async appendMessage(tenantId: string, userId: string, msg: MessageRecord): Promise<void> {
    const filePath = this.messagesPath(tenantId, userId, msg.conversation_id);
    const all = await this.readJson<MessageRecord[]>(filePath, []);
    // Check if message already exists (idempotent)
    const existing = all.findIndex(m => m.id === msg.id);
    if (existing >= 0) {
      all[existing] = msg;
    } else {
      all.push(msg);
    }
    await this.writeJson(filePath, all);
  }

  async updateMessageAnswer(tenantId: string, userId: string,
    conversationId: string, messageId: string, answer: string
  ): Promise<void> {
    const filePath = this.messagesPath(tenantId, userId, conversationId);
    const all = await this.readJson<MessageRecord[]>(filePath, []);
    const msg = all.find(m => m.id === messageId);
    if (msg) {
      msg.answer = answer;
      await this.writeJson(filePath, all);
    }
  }
}

export const conversationStore = new ConversationStore();
