import { buildCodexHeaders } from "./codex.js";
import type { Session } from "./config.js";

export interface WorktreeMapping {
  original: string;  // original repo root, e.g. /Users/x/project
  worktree: string;  // active worktree path, e.g. /Users/x/project/.claude/worktrees/agent-abc
}

// --- Request Translation: Anthropic Messages → OpenAI Responses API ---

export function translateRequest(
  body: any,
  session: Session & { name: string },
): { url: string; headers: Record<string, string>; body: string } {
  if (!session.model_override) {
    throw new Error("OpenAI session requires model_override to be set.");
  }

  const openaiBody: any = {
    model: session.model_override,
    stream: body.stream ?? false,
  };

  // Note: chatgpt.com/backend-api/codex does not support max_output_tokens, temperature, top_p

  // System prompt → instructions (required by Codex backend)
  if (body.system) {
    const instructions = translateSystem(body.system);
    openaiBody.instructions = instructions || "You are a helpful assistant.";
  } else {
    openaiBody.instructions = "You are a helpful assistant.";
  }

  // Messages → input array
  if (body.messages) {
    openaiBody.input = translateMessages(body.messages);
  }

  // Tools
  if (body.tools?.length) {
    openaiBody.tools = translateTools(body.tools);
  }

  if (body.tool_choice) {
    openaiBody.tool_choice = translateToolChoice(body.tool_choice);
  }

  const headers = buildCodexHeaders(session.token, session.account_id || "");
  headers["content-type"] = "application/json";

  // Codex OAuth tokens use chatgpt.com backend, not api.openai.com
  const wsUrl = "wss://chatgpt.com/backend-api/codex/responses";

  return {
    url: wsUrl,
    headers,
    body: JSON.stringify(openaiBody),
  };
}

function translateSystem(system: any): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";

  return system
    .filter(
      (block: any) =>
        block.type === "text" &&
        !block.text?.includes("x-anthropic-billing-header"),
    )
    .map((block: any) => block.text)
    .join("\n");
}

function translateMessages(messages: any[]): any[] {
  const result: any[] = [];
  // Map original tool IDs to fc_ prefixed IDs for consistency
  const idMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(...translateUserMessage(msg, idMap));
    } else if (msg.role === "assistant") {
      result.push(...translateAssistantMessage(msg, idMap));
    }
  }

  return result;
}

function toFcId(id: string, idMap: Map<string, string>): string {
  if (id.startsWith("fc_")) return id;
  if (idMap.has(id)) return idMap.get(id)!;
  const fcId = `fc_${id}`;
  idMap.set(id, fcId);
  return fcId;
}

function translateUserMessage(msg: any, idMap: Map<string, string>): any[] {
  const content = msg.content;

  // Simple string content
  if (typeof content === "string") {
    return [{ type: "message", role: "user", content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "message", role: "user", content: JSON.stringify(content) }];
  }

  const toolResults: any[] = [];
  const contentParts: any[] = [];

  for (const block of content) {
    if (block.type === "tool_result") {
      toolResults.push(translateToolResult(block, idMap));
    } else if (block.type === "text") {
      contentParts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      contentParts.push(translateImage(block));
    }
  }

  const result: any[] = [];

  // Tool results become function_call_output items
  result.push(...toolResults);

  // Remaining content becomes a user message
  if (contentParts.length === 1 && contentParts[0].type === "input_text") {
    result.push({ type: "message", role: "user", content: contentParts[0].text });
  } else if (contentParts.length > 0) {
    result.push({ type: "message", role: "user", content: contentParts });
  }

  return result;
}

function translateAssistantMessage(msg: any, idMap: Map<string, string>): any[] {
  const content = msg.content;

  if (typeof content === "string") {
    return [{ type: "message", role: "assistant", content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "message", role: "assistant", content: JSON.stringify(content) }];
  }

  const items: any[] = [];
  let textParts: string[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      // Flush text first as a message
      if (textParts.length > 0) {
        items.push({ type: "message", role: "assistant", content: textParts.join("\n") });
        textParts = [];
      }
      // Tool use → function_call output item
      const fcId = toFcId(block.id, idMap);
      items.push({
        type: "function_call",
        id: fcId,
        call_id: fcId,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
    // Skip "thinking" blocks
  }

  // Flush remaining text
  if (textParts.length > 0) {
    items.push({ type: "message", role: "assistant", content: textParts.join("\n") });
  }

  // If no items at all, emit empty assistant message
  if (items.length === 0) {
    items.push({ type: "message", role: "assistant", content: "" });
  }

  return items;
}

function translateToolResult(block: any, idMap: Map<string, string>): any {
  let output: string;
  if (typeof block.content === "string") {
    output = block.content;
  } else if (Array.isArray(block.content)) {
    output = block.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  } else {
    output = JSON.stringify(block.content ?? "");
  }

  return {
    type: "function_call_output",
    call_id: toFcId(block.tool_use_id, idMap),
    output,
  };
}

function translateImage(block: any): any {
  const source = block.source;
  if (source?.type === "base64") {
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${source.data}`,
    };
  }
  if (source?.type === "url") {
    return {
      type: "input_image",
      image_url: source.url,
    };
  }
  return { type: "input_text", text: "[unsupported image format]" };
}

function translateTools(tools: any[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.input_schema || {},
  }));
}

function translateToolChoice(choice: any): any {
  if (typeof choice === "string") {
    if (choice === "any") return "required";
    return choice;
  }
  if (choice?.type === "tool") {
    return { type: "function", name: choice.name };
  }
  return "auto";
}

// --- Path rewriting for worktree sessions ---

const PATH_FIELDS = ["file_path", "path"];

/**
 * Rewrite absolute path tokens in a Bash `command` string.
 *
 * Uses a negative-lookahead regex so that paths already inside the worktree
 * (`mapping.original + mapping.worktree_suffix + /`) are left untouched while
 * bare `mapping.original/...` occurrences are promoted to the worktree path.
 *
 * Conservative by design: only rewrites tokens that are immediately followed
 * by `/`, so partial prefix matches (e.g. `/repo2/`) are never affected.
 */
function rewriteCommandTokens(command: string, mapping: WorktreeMapping): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // worktree = original + suffix, e.g. "/repo" + "/.claude/worktrees/feat"
  const suffix = mapping.worktree.slice(mapping.original.length); // "/.claude/worktrees/feat"
  // Match mapping.original NOT already followed by the worktree suffix.
  // The trailing lookahead accepts / (sub-path), whitespace, common shell delimiters,
  // or end-of-string so that partial-prefix matches (/repo2/) are never rewritten.
  const re = new RegExp(`${esc(mapping.original)}(?!${esc(suffix)})(?=[/\\s'";&|]|$)`, "g");
  return command.replace(re, mapping.worktree);
}

function rewriteInputPaths(input: any, mapping: WorktreeMapping): { result: any; rewritten: boolean } {
  if (!input || typeof input !== "object") return { result: input, rewritten: false };
  const result = { ...input };
  let rewritten = false;
  for (const field of PATH_FIELDS) {
    if (
      typeof result[field] === "string" &&
      result[field].startsWith(mapping.original + "/") &&
      !result[field].startsWith(mapping.worktree + "/")
    ) {
      result[field] = mapping.worktree + result[field].slice(mapping.original.length);
      rewritten = true;
    }
  }
  if (typeof result.command === "string" && result.command.includes(mapping.original + "/")) {
    const rewrittenCmd = rewriteCommandTokens(result.command, mapping);
    if (rewrittenCmd !== result.command) {
      result.command = rewrittenCmd;
      rewritten = true;
    }
  }
  return { result, rewritten };
}

// --- Non-Streaming Response Translation: OpenAI Responses → Anthropic ---

export function translateResponse(openaiRes: any, mapping?: WorktreeMapping | null): { response: any; pathRewritten: boolean } {
  const content: any[] = [];
  let pathRewritten = false;

  if (openaiRes.output) {
    for (const item of openaiRes.output) {
      if (item.type === "message" && item.content) {
        for (const part of item.content) {
          if (part.type === "output_text") {
            content.push({ type: "text", text: part.text });
          }
        }
      } else if (item.type === "function_call") {
        const input = safeJsonParse(item.arguments, true);
        let finalInput = input;
        if (mapping) {
          const { result, rewritten } = rewriteInputPaths(input, mapping);
          finalInput = result;
          if (rewritten) pathRewritten = true;
        }
        content.push({
          type: "tool_use",
          id: toToolUseId(item.call_id || item.id),
          name: item.name,
          input: finalInput,
        });
      }
    }
  }

  return {
    response: {
      id: `msg_${openaiRes.id || "unknown"}`,
      type: "message",
      role: "assistant",
      model: openaiRes.model,
      content,
      stop_reason: mapStopReason(openaiRes.status),
      usage: {
        input_tokens: openaiRes.usage?.input_tokens || 0,
        output_tokens: openaiRes.usage?.output_tokens || 0,
      },
    },
    pathRewritten,
  };
}

function mapStopReason(status: string | null): string {
  switch (status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

function toToolUseId(id: string): string {
  if (id.startsWith("toolu_")) return id;
  // Convert OpenAI call_xxx to Anthropic toolu_xxx
  return `toolu_${id.replace(/^call_/, "")}`;
}

/** Thrown when a tool-call argument string is not valid JSON.
 *  Callers that can still fail the request should catch this and return a
 *  translation_error response rather than silently producing {} inputs. */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

function safeJsonParse(str: string, strict?: false): any;
function safeJsonParse(str: string, strict: true): any;
function safeJsonParse(str: string, strict = false): any {
  try {
    return JSON.parse(str);
  } catch {
    if (strict) throw new TranslationError(`Invalid JSON in tool call arguments: ${str.slice(0, 120)}`);
    return {};
  }
}

// --- WebSocket Event Processor: OpenAI Responses WS → Anthropic SSE ---

interface StreamState {
  started: boolean;
  messageId: string;
  model: string;
  contentBlockIndex: number;
  textBlockOpen: boolean;
  toolBlockByOutputIndex: Map<number, { blockIdx: number; callId: string }>; // output_index → block info
  toolArgBuffer: Map<number, string>; // output_index → accumulated arguments string (for path rewriting)
  inputTokens: number;
  outputTokens: number;
}

/**
 * Creates a stateful event processor for translating OpenAI Responses API
 * WebSocket messages into Anthropic SSE events.
 *
 * Returns a function: (event, writeEvent) => void
 * Call with each parsed WS message. Use { type: "_finish" } to emit message_stop.
 *
 * When mapping is provided, tool call file_path arguments are rewritten from
 * the original repo root to the active worktree path before being emitted.
 * Tool call arguments are buffered until complete so the rewrite can be applied.
 */
export function createWsEventProcessor(mapping?: WorktreeMapping | null): (
  data: any,
  writeEvent: (event: string, data: any) => void,
) => void {
  const state: StreamState = {
    started: false,
    messageId: `msg_${Date.now()}`,
    model: "unknown",
    contentBlockIndex: 0,
    textBlockOpen: false,
    toolBlockByOutputIndex: new Map(),
    toolArgBuffer: new Map(),
    inputTokens: 0,
    outputTokens: 0,
  };

  return (data: any, writeEvent: (event: string, data: any) => void) => {
    if (data.type === "_finish") {
      finishStream(state, writeEvent);
      return;
    }
    processEvent(data, state, writeEvent, mapping ?? null);
  };
}

function processEvent(
  data: any,
  state: StreamState,
  writeEvent: (event: string, data: any) => void,
  mapping: WorktreeMapping | null,
): void {
  const eventType = data.type;

  switch (eventType) {
    case "response.created": {
      const resp = data.response;
      state.messageId = `msg_${resp?.id || Date.now()}`;
      state.model = resp?.model || "unknown";
      state.started = true;

      writeEvent("message_start", {
        type: "message_start",
        message: {
          id: state.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      break;
    }

    case "response.output_item.added": {
      const item = data.item;
      if (item?.type === "message") {
        // Will receive text deltas next
      } else if (item?.type === "function_call") {
        // Close text block if open
        if (state.textBlockOpen) {
          writeEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.contentBlockIndex,
          });
          state.contentBlockIndex++;
          state.textBlockOpen = false;
        }

        const blockIdx = state.contentBlockIndex;
        const callId = item.call_id || item.id;
        const outputIndex = data.output_index ?? 0;
        state.toolBlockByOutputIndex.set(outputIndex, { blockIdx, callId });

        writeEvent("content_block_start", {
          type: "content_block_start",
          index: blockIdx,
          content_block: {
            type: "tool_use",
            id: toToolUseId(callId),
            name: item.name || "",
            input: {},
          },
        });
        state.contentBlockIndex++;
      }
      break;
    }

    case "response.content_part.added": {
      // Start of a text content part
      if (!state.textBlockOpen) {
        writeEvent("content_block_start", {
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        });
        state.textBlockOpen = true;
      }
      break;
    }

    case "response.output_text.delta": {
      // Ensure text block is open
      if (!state.textBlockOpen) {
        writeEvent("content_block_start", {
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        });
        state.textBlockOpen = true;
      }

      writeEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "text_delta", text: data.delta },
      });
      break;
    }

    case "response.output_text.done": {
      if (state.textBlockOpen) {
        writeEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentBlockIndex,
        });
        state.contentBlockIndex++;
        state.textBlockOpen = false;
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      const outputIndex = data.output_index ?? 0;
      const info = state.toolBlockByOutputIndex.get(outputIndex);
      if (info) {
        if (mapping) {
          // Buffer args for path rewriting on done; don't emit deltas yet
          state.toolArgBuffer.set(outputIndex, (state.toolArgBuffer.get(outputIndex) ?? "") + (data.delta ?? ""));
        } else {
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: info.blockIdx,
            delta: { type: "input_json_delta", partial_json: data.delta },
          });
        }
      }
      break;
    }

    case "response.function_call_arguments.done": {
      const outputIndex = data.output_index ?? 0;
      const info = state.toolBlockByOutputIndex.get(outputIndex);
      if (info) {
        if (mapping) {
          // Rewrite paths in the complete arguments, then emit as a single delta
          const rawArgs = state.toolArgBuffer.get(outputIndex) ?? data.arguments ?? "";
          let parsed: any;
          try {
            parsed = JSON.parse(rawArgs);
          } catch {
            throw new TranslationError(`Tool call arguments are not valid JSON (outputIndex=${outputIndex}): ${rawArgs.slice(0, 120)}`);
          }
          const { result: rewritten } = rewriteInputPaths(parsed, mapping);
          const rewrittenJson = JSON.stringify(rewritten);
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: info.blockIdx,
            delta: { type: "input_json_delta", partial_json: rewrittenJson },
          });
          state.toolArgBuffer.delete(outputIndex);
        }
        writeEvent("content_block_stop", {
          type: "content_block_stop",
          index: info.blockIdx,
        });
        state.toolBlockByOutputIndex.delete(outputIndex);
      }
      break;
    }

    case "response.completed": {
      const resp = data.response;
      if (resp?.usage) {
        state.inputTokens = resp.usage.input_tokens || 0;
        state.outputTokens = resp.usage.output_tokens || 0;
      }

      closeAllBlocks(state, writeEvent);

      const stopReason = mapStopReason(resp?.status);
      writeEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      });
      break;
    }
  }
}

function closeAllBlocks(
  state: StreamState,
  writeEvent: (event: string, data: any) => void,
): void {
  if (state.textBlockOpen) {
    writeEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.contentBlockIndex,
    });
    state.contentBlockIndex++;
    state.textBlockOpen = false;
  }

  for (const [, info] of state.toolBlockByOutputIndex) {
    writeEvent("content_block_stop", {
      type: "content_block_stop",
      index: info.blockIdx,
    });
  }
  state.toolBlockByOutputIndex.clear();
}

function finishStream(
  state: StreamState,
  writeEvent: (event: string, data: any) => void,
): void {
  closeAllBlocks(state, writeEvent);
  if (!state.started) return;
  writeEvent("message_stop", { type: "message_stop" });
}
