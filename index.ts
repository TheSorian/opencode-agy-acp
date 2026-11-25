/**
 * OpenCode v2 Plugin: Official Antigravity ACP (`agy acp`) Provider
 *
 * Runs an in-process OpenAI-compatible HTTP bridge on 127.0.0.1:18799
 * backed exclusively by the official `agy acp --stdio` Agent Client Protocol
 * server. Lets you pick any `agy` model directly in OpenCode's model selector
 * without any external proxy daemon or unofficial API calls.
 */

const PORT = Number(process.env.AGY_ACP_PORT || "18799");
const AGY_BIN = process.env.AGY_BIN || "agy";
const AUTO_APPROVE = process.env.AGY_ACP_AUTO_APPROVE === "true";
const MAX_SESSIONS = 6;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface SessionState {
  sessionId: string;
  modelId: string;
  messageCount: number;
  lastUsed: number;
}

type UpdateListener = (update: any) => void;

class AgyAcpClient {
  private proc: any = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  private listeners = new Map<string, Set<UpdateListener>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private availableModels: Array<{ modelId: string; name: string }> = [];
  private sessions = new Map<string, SessionState>();
  private sessionLocks = new Map<string, Promise<void>>();

  async ensureReady(): Promise<void> {
    if (this.initialized && this.proc) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._start().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _start(): Promise<void> {
    const BunRuntime = (globalThis as any).Bun;
    this.proc = BunRuntime.spawn([AGY_BIN, "acp", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this._readStdout(this.proc.stdout);
    this._drainStderr(this.proc.stderr);

    this.proc.exited.then(() => {
      this.initialized = false;
      this.proc = null;
      this.sessions.clear();
      for (const [, p] of this.pending) {
        p.reject(new Error("agy acp process exited unexpectedly"));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "opencode-agy-acp-plugin", version: "1.0.0" },
    });

    this.initialized = true;
  }

  private async _readStdout(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg: JsonRpcMessage = JSON.parse(line);
            this._handleMessage(msg);
          } catch {
            // Ignore non-JSON lines if any
          }
        }
      }
    } catch {
      // Stream closed
    }
  }

  private async _drainStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Ignore
    }
  }

  private _write(msg: JsonRpcMessage) {
    if (!this.proc?.stdin) {
      throw new Error("agy acp stdin is not available");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    if (typeof this.proc.stdin.flush === "function") {
      this.proc.stdin.flush();
    }
  }

  private _handleMessage(msg: JsonRpcMessage) {
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(
            new Error(`ACP error ${msg.error.code}: ${msg.error.message}`)
          );
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // Server -> Client request (e.g. session/request_permission)
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "session/request_permission") {
        const options: Array<{ optionId: string; kind?: string }> =
          msg.params?.options || [];
        const chosen = AUTO_APPROVE
          ? options.find((o) => o.kind?.includes("allow")) || options[0]
          : options.find((o) => o.kind?.includes("reject")) ||
            options[options.length - 1];

        this._write({
          jsonrpc: "2.0",
          id: msg.id,
          result: chosen
            ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
      } else {
        this._write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not supported: ${msg.method}` },
        });
      }
      return;
    }

    // Notification (session/update)
    if (msg.method === "session/update") {
      const sid: string | undefined = msg.params?.sessionId;
      const update = msg.params?.update;
      if (sid && update) {
        const set = this.listeners.get(sid);
        if (set) {
          for (const fn of set) fn(update);
        }
      }
    }
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (err: any) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  onSessionUpdate(sessionId: string, fn: UpdateListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  async getAvailableModels(): Promise<Array<{ modelId: string; name: string }>> {
    await this.ensureReady();
    if (this.availableModels.length > 0) return this.availableModels;
    const res = await this.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    if (res?.models?.availableModels) {
      this.availableModels = res.models.availableModels;
    }
    if (res?.sessionId) {
      this.request("session/close", { sessionId: res.sessionId }).catch(() => {});
    }
    return this.availableModels;
  }

  async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.sessionLocks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async getOrCreateSession(
    convKey: string,
    modelId: string,
    messageCount: number,
    cwd: string
  ): Promise<{ session: SessionState; isNew: boolean }> {
    await this.ensureReady();

    const existing = this.sessions.get(convKey);
    // Reuse session only if conversation strictly grew
    if (existing && messageCount > existing.messageCount) {
      existing.lastUsed = Date.now();
      if (existing.modelId !== modelId) {
        await this.request("session/set_model", {
          sessionId: existing.sessionId,
          modelId,
        });
        existing.modelId = modelId;
      }
      return { session: existing, isNew: false };
    }

    // Close old session if conversation was rewound/restarted
    if (existing) {
      this.request("session/close", { sessionId: existing.sessionId }).catch(
        () => {}
      );
      this.sessions.delete(convKey);
    }

    // Evict LRU if too many active sessions
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsed < oldestTime) {
          oldestTime = s.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const old = this.sessions.get(oldestKey)!;
        this.sessions.delete(oldestKey);
        this.request("session/close", { sessionId: old.sessionId }).catch(
          () => {}
        );
      }
    }

    const res = await this.request("session/new", {
      cwd,
      mcpServers: [],
    });
    if (res?.models?.availableModels) {
      this.availableModels = res.models.availableModels;
    }

    const sessionId: string = res.sessionId;
    if (modelId) {
      await this.request("session/set_model", { sessionId, modelId });
    }

    const state: SessionState = {
      sessionId,
      modelId,
      messageCount: 0,
      lastUsed: Date.now(),
    };
    this.sessions.set(convKey, state);
    return { session: state, isNew: true };
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // Ignore
      }
      this.proc = null;
    }
    this.initialized = false;
    this.sessions.clear();
    this.pending.clear();
    this.listeners.clear();
  }
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildConversationKey(messages: any[]): string {
  const sys = messages.find((m) => m.role === "system");
  const firstUser = messages.find((m) => m.role === "user");
  const raw =
    (sys ? extractText(sys.content).slice(0, 200) : "") +
    "||" +
    (firstUser ? extractText(firstUser.content).slice(0, 300) : "");
  // Simple FNV-1a hash
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `conv_${(hash >>> 0).toString(16)}`;
}

function buildPromptText(messages: any[], isNew: boolean): string {
  if (!isNew) {
    // Send only the latest user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return extractText(messages[i].content);
      }
    }
    return extractText(messages[messages.length - 1]?.content);
  }

  // New session: include system instruction (briefly) + any prior turns
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 1 && nonSystem[0].role === "user") {
    return extractText(nonSystem[0].content);
  }

  return nonSystem
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${extractText(m.content)}`;
    })
    .join("\n\n");
}

const MODELS_WITH_EFFORT: Record<string, { default: string; allowed: string[] }> = {
  "gemini-4-neon": { default: "medium", allowed: ["low", "medium", "high", "xhigh"] },
  "gemini-4-carbon": { default: "medium", allowed: ["low", "medium", "high"] },
  "gemini-4-argon": { default: "medium", allowed: ["low", "medium", "high"] },
  "gemini-4-hydrogen": { default: "medium", allowed: ["low", "medium", "high", "xhigh"] },
  "gemini-3.8-flash": { default: "medium", allowed: ["low", "medium", "high"] },
  "claude-opus-5-5": { default: "medium", allowed: ["low", "medium", "high"] },
  "claude-sonnet-5-5": { default: "medium", allowed: ["low", "medium", "high"] },
};

function resolveAgyModelId(rawModel: string, body: any, headers: Headers): string {
  const spec = MODELS_WITH_EFFORT[rawModel];
  if (!spec) return rawModel;

  const rawEffort =
    headers.get("x-agy-effort") ||
    body?.reasoning_effort ||
    body?.reasoning?.effort ||
    body?.effort ||
    spec.default;

  const effort = String(rawEffort).toLowerCase().trim();
  const chosen = spec.allowed.includes(effort) ? effort : spec.default;
  return `${rawModel}-${chosen}`;
}

function makeChunk(
  id: string,
  model: string,
  delta: Record<string, any>,
  finishReason: string | null = null,
  usage?: any
): string {
  const payload: any = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export default {
  id: "agy-acp",
  async setup(ctx: any) {
    const client = new AgyAcpClient();
    let lastResolvedModel: string | null = null;
    const cwd = ctx?.location?.directory || process.cwd();
    const BunRuntime = (globalThis as any).Bun;
    let server: any = null;

    try {
      server = BunRuntime.serve({
        hostname: "127.0.0.1",
        port: PORT,
        idleTimeout: 255,
        async fetch(req: Request) {
          const url = new URL(req.url);

          if (req.method === "GET" && url.pathname === "/health") {
            return Response.json({
              ok: true,
              backend: "agy acp",
              lastModel: lastResolvedModel,
            });
          }

          if (
            req.method === "GET" &&
            (url.pathname === "/v1/models" || url.pathname === "/models")
          ) {
            try {
              const models = await client.getAvailableModels();
              return Response.json({
                object: "list",
                data: models.map((m) => ({
                  id: m.modelId,
                  object: "model",
                  owned_by: "antigravity",
                  name: m.name,
                })),
              });
            } catch (err: any) {
              return Response.json(
                { error: { message: err?.message || String(err) } },
                { status: 500 }
              );
            }
          }

          if (
            req.method === "POST" &&
            (url.pathname === "/v1/chat/completions" ||
              url.pathname === "/chat/completions")
          ) {
            let body: any;
            try {
              body = await req.json();
            } catch {
              return Response.json(
                { error: { message: "Invalid JSON body" } },
                { status: 400 }
              );
            }

            const rawModel: string = body.model || "gemini-4-neon";
            const model: string = resolveAgyModelId(rawModel, body, req.headers);
            lastResolvedModel = model;
            const messages: any[] = Array.isArray(body.messages)
              ? body.messages
              : [];
            const stream: boolean = body.stream !== false;
            const convKey = buildConversationKey(messages);
            const completionId = `chatcmpl-acp-${Date.now().toString(36)}`;

            if (stream) {
              const encoder = new TextEncoder();
              const readable = new ReadableStream({
                async start(controller) {
                  let closed = false;
                  const send = (str: string) => {
                    if (!closed) controller.enqueue(encoder.encode(str));
                  };
                  const finish = () => {
                    if (!closed) {
                      closed = true;
                      controller.close();
                    }
                  };

                  try {
                    await client.withSessionLock(convKey, async () => {
                      const { session, isNew } = await client.getOrCreateSession(
                        convKey,
                        model,
                        messages.length,
                        cwd
                      );
                      const promptText = buildPromptText(messages, isNew);

                      send(makeChunk(completionId, model, { role: "assistant" }));

                      const unsub = client.onSessionUpdate(
                        session.sessionId,
                        (update) => {
                          if (
                            update.sessionUpdate === "agent_message_chunk" &&
                            update.content?.type === "text" &&
                            update.content.text
                          ) {
                            send(
                              makeChunk(completionId, model, {
                                content: update.content.text,
                              })
                            );
                          } else if (
                            update.sessionUpdate === "agent_thought_chunk" &&
                            update.content?.type === "text" &&
                            update.content.text
                          ) {
                            send(
                              makeChunk(completionId, model, {
                                reasoning_content: update.content.text,
                              })
                            );
                          }
                        }
                      );

                      try {
                        const res = await client.request("session/prompt", {
                          sessionId: session.sessionId,
                          prompt: [{ type: "text", text: promptText }],
                        });
                        session.messageCount = messages.length;
                        const u = res?.usage;
                        const usage = u
                          ? {
                              prompt_tokens: u.inputTokens ?? 0,
                              completion_tokens: u.outputTokens ?? 0,
                              total_tokens: u.totalTokens ?? 0,
                            }
                          : undefined;
                        send(makeChunk(completionId, model, {}, "stop", usage));
                        send("data: [DONE]\n\n");
                      } finally {
                        unsub();
                      }
                    });
                  } catch (err: any) {
                    send(
                      makeChunk(
                        completionId,
                        model,
                        {
                          content: `\n[agy-acp error: ${err?.message || String(err)}]`,
                        },
                        "stop"
                      )
                    );
                    send("data: [DONE]\n\n");
                  } finally {
                    finish();
                  }
                },
              });

              return new Response(readable, {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                  connection: "keep-alive",
                },
              });
            }

            // Non-streaming response
            try {
              const result = await client.withSessionLock(convKey, async () => {
                const { session, isNew } = await client.getOrCreateSession(
                  convKey,
                  model,
                  messages.length,
                  cwd
                );
                const promptText = buildPromptText(messages, isNew);
                let text = "";
                let reasoning = "";

                const unsub = client.onSessionUpdate(
                  session.sessionId,
                  (update) => {
                    if (
                      update.sessionUpdate === "agent_message_chunk" &&
                      update.content?.type === "text" &&
                      update.content.text
                    ) {
                      text += update.content.text;
                    } else if (
                      update.sessionUpdate === "agent_thought_chunk" &&
                      update.content?.type === "text" &&
                      update.content.text
                    ) {
                      reasoning += update.content.text;
                    }
                  }
                );

                try {
                  const res = await client.request("session/prompt", {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: promptText }],
                  });
                  session.messageCount = messages.length;
                  return { text, reasoning, usage: res?.usage };
                } finally {
                  unsub();
                }
              });

              const u = result.usage;
              return Response.json({
                id: completionId,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: result.text,
                      ...(result.reasoning
                        ? { reasoning_content: result.reasoning }
                        : {}),
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: u
                  ? {
                      prompt_tokens: u.inputTokens ?? 0,
                      completion_tokens: u.outputTokens ?? 0,
                      total_tokens: u.totalTokens ?? 0,
                    }
                  : undefined,
              });
            } catch (err: any) {
              return Response.json(
                { error: { message: err?.message || String(err) } },
                { status: 500 }
              );
            }
          }

          return new Response("Not Found", { status: 404 });
        },
      });
    } catch (e: any) {
      if (e?.code !== "EADDRINUSE") {
        throw e;
      }
      // Another OpenCode instance is already serving the in-process ACP bridge
    }

    return () => {
      if (server) server.stop(true);
      client.stop();
    };
  },
};
