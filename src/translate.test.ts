/**
 * Unit tests for src/translate.ts
 * Run with: tsx --test src/translate.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateRequest, translateResponse, createWsEventProcessor, TranslationError } from "./translate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal session that satisfies the Session & { name } shape */
function makeSession(overrides: Record<string, any> = {}) {
  return {
    name: "test",
    provider: "openai" as const,
    token: "test-token",
    base_url: "https://api.openai.com",
    account_id: "acct_123",
    model_override: "gpt-4o",
    ...overrides,
  };
}

/** Collect all events emitted by a processor run */
function collectEvents(
  processor: (data: any, write: (e: string, d: any) => void) => void,
  eventSequence: any[],
): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  const write = (event: string, data: any) => out.push({ event, data });
  for (const evt of eventSequence) {
    processor(evt, write);
  }
  return out;
}

// ---------------------------------------------------------------------------
// translateRequest
// ---------------------------------------------------------------------------

describe("translateRequest", () => {
  // --- model_override required ---
  it("throws when model_override is missing", () => {
    const session = makeSession({ model_override: undefined });
    assert.throws(
      () => translateRequest({ messages: [] }, session),
      /model_override/,
    );
  });

  // --- instructions / system ---
  it("uses fallback instructions when system is absent", () => {
    const result = translateRequest({ messages: [] }, makeSession());
    const body = JSON.parse(result.body);
    assert.equal(body.instructions, "You are a helpful assistant.");
  });

  it("uses fallback instructions when system is an empty string", () => {
    const result = translateRequest({ system: "", messages: [] }, makeSession());
    const body = JSON.parse(result.body);
    assert.equal(body.instructions, "You are a helpful assistant.");
  });

  it("translates system string directly to instructions", () => {
    const result = translateRequest(
      { system: "Be concise.", messages: [] },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.instructions, "Be concise.");
  });

  it("translates system array to instructions, joining text blocks", () => {
    const result = translateRequest(
      {
        system: [
          { type: "text", text: "Block one." },
          { type: "text", text: "Block two." },
        ],
        messages: [],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.instructions, "Block one.\nBlock two.");
  });

  it("filters out billing header blocks from system array", () => {
    const result = translateRequest(
      {
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli;",
          },
          { type: "text", text: "Real instruction." },
        ],
        messages: [],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.instructions, "Real instruction.");
  });

  // --- message translation ---
  it("translates user text message (string content)", () => {
    const result = translateRequest(
      { messages: [{ role: "user", content: "Hello" }] },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.deepEqual(body.input, [
      { type: "message", role: "user", content: "Hello" },
    ]);
  });

  it("translates user text content block", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hi there" }],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].type, "message");
    assert.equal(body.input[0].role, "user");
    assert.equal(body.input[0].content, "Hi there");
  });

  it("translates assistant text message", () => {
    const result = translateRequest(
      { messages: [{ role: "assistant", content: "Hello back" }] },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.deepEqual(body.input, [
      { type: "message", role: "assistant", content: "Hello back" },
    ]);
  });

  it("translates assistant tool_use block to function_call", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_abc",
                name: "get_weather",
                input: { city: "Paris" },
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input.length, 1);
    const fc = body.input[0];
    assert.equal(fc.type, "function_call");
    assert.equal(fc.name, "get_weather");
    assert.equal(fc.arguments, JSON.stringify({ city: "Paris" }));
    // ID should get fc_ prefix
    assert.ok(fc.id.startsWith("fc_"), `expected fc_ prefix, got: ${fc.id}`);
    assert.equal(fc.call_id, fc.id);
  });

  it("flushes text before tool_use block in assistant message", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "toolu_xyz",
                name: "lookup",
                input: {},
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input.length, 2);
    assert.equal(body.input[0].type, "message");
    assert.equal(body.input[0].content, "Let me check.");
    assert.equal(body.input[1].type, "function_call");
  });

  it("translates tool_result in user message to function_call_output", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: "72°F and sunny",
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input.length, 1);
    const fco = body.input[0];
    assert.equal(fco.type, "function_call_output");
    assert.equal(fco.output, "72°F and sunny");
    assert.ok(
      fco.call_id.startsWith("fc_"),
      `expected fc_ prefix, got: ${fco.call_id}`,
    );
  });

  it("translates tool_result with array content", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: [
                  { type: "text", text: "Line 1" },
                  { type: "text", text: "Line 2" },
                ],
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input[0].output, "Line 1\nLine 2");
  });

  // --- ID consistency: tool_use id ↔ tool_result tool_use_id ---
  it("maps tool_use id to the same fc_ id used in the matching tool_result", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_001",
                name: "fn",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_001",
                content: "ok",
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    const fc = body.input[0]; // function_call
    const fco = body.input[1]; // function_call_output
    assert.equal(fc.call_id, fco.call_id);
  });

  // --- Tool schema translation ---
  it("translates tool input_schema to parameters", () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const result = translateRequest(
      {
        messages: [],
        tools: [
          {
            name: "search",
            description: "Search the web",
            input_schema: schema,
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.tools.length, 1);
    const tool = body.tools[0];
    assert.equal(tool.type, "function");
    assert.equal(tool.name, "search");
    assert.equal(tool.description, "Search the web");
    assert.deepEqual(tool.parameters, schema);
  });

  // --- tool_choice ---
  it('translates tool_choice "any" → "required"', () => {
    const result = translateRequest(
      { messages: [], tool_choice: "any" },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.tool_choice, "required");
  });

  it('translates tool_choice "auto" → "auto"', () => {
    const result = translateRequest(
      { messages: [], tool_choice: "auto" },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.tool_choice, "auto");
  });

  it("translates tool_choice {type:'tool'} → {type:'function', name}", () => {
    const result = translateRequest(
      {
        messages: [],
        tool_choice: { type: "tool", name: "search" },
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.deepEqual(body.tool_choice, { type: "function", name: "search" });
  });

  it("translates tool_choice unknown object → 'auto'", () => {
    const result = translateRequest(
      { messages: [], tool_choice: { type: "unknown" } },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.tool_choice, "auto");
  });

  // --- Image translation ---
  it("translates base64 image block", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc123",
                },
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    // Single image → content array with input_image
    const msg = body.input[0];
    assert.equal(msg.type, "message");
    assert.ok(Array.isArray(msg.content));
    assert.equal(msg.content[0].type, "input_image");
    assert.equal(msg.content[0].image_url, "data:image/png;base64,abc123");
  });

  it("translates url image block", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/pic.jpg" },
              },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    const msg = body.input[0];
    assert.equal(msg.content[0].type, "input_image");
    assert.equal(msg.content[0].image_url, "https://example.com/pic.jpg");
  });

  // --- URL / model ---
  it("sets the WebSocket URL to chatgpt.com codex endpoint", () => {
    const result = translateRequest({ messages: [] }, makeSession());
    assert.equal(result.url, "wss://chatgpt.com/backend-api/codex/responses");
  });

  it("sets the model in the output body", () => {
    const result = translateRequest({ messages: [] }, makeSession());
    const body = JSON.parse(result.body);
    assert.equal(body.model, "gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// translateResponse
// ---------------------------------------------------------------------------

describe("translateResponse", () => {
  it("translates text output to text content block", () => {
    const openaiRes = {
      id: "resp_001",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello, world!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const { response: result } = translateResponse(openaiRes);

    assert.equal(result.id, "msg_resp_001");
    assert.equal(result.type, "message");
    assert.equal(result.role, "assistant");
    assert.equal(result.model, "gpt-4o");
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "Hello, world!");
  });

  it("translates function_call output to tool_use content block", () => {
    const openaiRes = {
      id: "resp_002",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_abc123",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
      ],
      usage: { input_tokens: 8, output_tokens: 12 },
    };

    const { response: result } = translateResponse(openaiRes);

    assert.equal(result.content.length, 1);
    const block = result.content[0];
    assert.equal(block.type, "tool_use");
    assert.equal(block.name, "get_weather");
    assert.deepEqual(block.input, { city: "Tokyo" });
    // call_abc123 → toolu_abc123
    assert.equal(block.id, "toolu_abc123");
  });

  it("translates function_call with id fallback when call_id absent", () => {
    const openaiRes = {
      id: "resp_003",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "call_xyz",
          name: "fn",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const { response: result } = translateResponse(openaiRes);
    assert.equal(result.content[0].id, "toolu_xyz");
  });

  it("already-prefixed toolu_ ids are not double-prefixed", () => {
    const openaiRes = {
      id: "resp_004",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "toolu_already",
          name: "fn",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const { response: result } = translateResponse(openaiRes);
    assert.equal(result.content[0].id, "toolu_already");
  });

  // --- stop_reason mapping ---
  it('maps status "completed" → stop_reason "end_turn"', () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: "completed",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.equal(result.stop_reason, "end_turn");
  });

  it('maps status "incomplete" → stop_reason "max_tokens"', () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: "incomplete",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.equal(result.stop_reason, "max_tokens");
  });

  it("maps unknown status → stop_reason end_turn (default)", () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: null,
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.equal(result.stop_reason, "end_turn");
  });

  // --- usage mapping ---
  it("maps usage fields correctly", () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: "completed",
      output: [],
      usage: { input_tokens: 42, output_tokens: 17 },
    });
    assert.equal(result.usage.input_tokens, 42);
    assert.equal(result.usage.output_tokens, 17);
  });

  it("defaults usage tokens to 0 when missing", () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: "completed",
      output: [],
      usage: {},
    });
    assert.equal(result.usage.input_tokens, 0);
    assert.equal(result.usage.output_tokens, 0);
  });

  it("throws TranslationError on malformed JSON tool call arguments", () => {
    assert.throws(
      () => translateResponse({
        id: "r",
        model: "m",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_bad",
            name: "fn",
            arguments: "NOT JSON",
          },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      (err: unknown) => {
        assert.ok(err instanceof TranslationError, "should be a TranslationError");
        assert.match((err as Error).message, /Invalid JSON in tool call arguments/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// createWsEventProcessor — ID conversion helpers (via processor output)
// ---------------------------------------------------------------------------

describe("ID conversion", () => {
  it("toFcId: adds fc_ prefix to a bare id", () => {
    // Exercise toFcId indirectly via translateRequest tool_use → function_call
    const result = translateRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "plain_id", name: "fn", input: {} },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input[0].id, "fc_plain_id");
  });

  it("toFcId: does not double-prefix an id that already starts with fc_", () => {
    const result = translateRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "fc_already", name: "fn", input: {} },
            ],
          },
        ],
      },
      makeSession(),
    );
    const body = JSON.parse(result.body);
    assert.equal(body.input[0].id, "fc_already");
  });

  it("toToolUseId: call_xxx → toolu_xxx (via translateResponse)", () => {
    const { response: result } = translateResponse({
      id: "r",
      model: "m",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_12345",
          name: "fn",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.equal(result.content[0].id, "toolu_12345");
  });
});

// ---------------------------------------------------------------------------
// createWsEventProcessor — streaming event translation
// ---------------------------------------------------------------------------

describe("createWsEventProcessor", () => {
  // --- response.created → message_start ---
  it("emits message_start on response.created", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "resp_stream_1", model: "gpt-4o" },
      },
    ]);

    assert.equal(events.length, 1);
    assert.equal(events[0].event, "message_start");
    const msg = events[0].data.message;
    assert.equal(msg.id, "msg_resp_stream_1");
    assert.equal(msg.role, "assistant");
    assert.equal(msg.model, "gpt-4o");
    assert.deepEqual(msg.content, []);
    assert.equal(msg.stop_reason, null);
  });

  // --- response.output_text.delta → content_block_delta (text_delta) ---
  it("emits content_block_start then content_block_delta for text delta", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r1", model: "gpt-4o" },
      },
      {
        type: "response.output_text.delta",
        delta: "Hello ",
      },
      {
        type: "response.output_text.delta",
        delta: "world",
      },
    ]);

    // message_start, content_block_start (auto-opened), then two deltas
    const starts = events.filter((e) => e.event === "content_block_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].data.content_block.type, "text");

    const deltas = events.filter((e) => e.event === "content_block_delta");
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].data.delta.type, "text_delta");
    assert.equal(deltas[0].data.delta.text, "Hello ");
    assert.equal(deltas[1].data.delta.text, "world");
  });

  // --- response.output_item.added (function_call) → content_block_start (tool_use) ---
  it("emits content_block_start with tool_use for function_call output item", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r2", model: "gpt-4o" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_tool1",
          call_id: "call_tool1",
          name: "get_weather",
        },
      },
    ]);

    const starts = events.filter((e) => e.event === "content_block_start");
    assert.equal(starts.length, 1);
    const cb = starts[0].data.content_block;
    assert.equal(cb.type, "tool_use");
    assert.equal(cb.name, "get_weather");
    // call_tool1 → toolu_tool1
    assert.equal(cb.id, "toolu_tool1");
    assert.deepEqual(cb.input, {});
  });

  // --- response.function_call_arguments.delta → content_block_delta (input_json_delta) ---
  it("emits input_json_delta for function_call_arguments.delta", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r3", model: "gpt-4o" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_t2",
          name: "fn",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"city"',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: ':"Paris"}',
      },
    ]);

    const deltas = events.filter((e) => e.event === "content_block_delta");
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].data.delta.type, "input_json_delta");
    assert.equal(deltas[0].data.delta.partial_json, '{"city"');
    assert.equal(deltas[1].data.delta.partial_json, ':"Paris"}');

    // Verify index matches the tool block's index
    const toolStart = events.find((e) => e.event === "content_block_start");
    assert.ok(toolStart);
    assert.equal(deltas[0].data.index, toolStart!.data.index);
  });

  // --- response.completed → message_delta + (then _finish) message_stop ---
  it("emits message_delta with stop_reason on response.completed", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r4", model: "gpt-4o" },
      },
      {
        type: "response.completed",
        response: {
          id: "r4",
          model: "gpt-4o",
          status: "completed",
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      },
    ]);

    const delta = events.find((e) => e.event === "message_delta");
    assert.ok(delta, "expected message_delta event");
    assert.equal(delta!.data.delta.stop_reason, "end_turn");
    assert.equal(delta!.data.usage.output_tokens, 10);
  });

  it("emits message_stop on _finish signal", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r5", model: "gpt-4o" },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
      { type: "_finish" },
    ]);

    const stop = events.find((e) => e.event === "message_stop");
    assert.ok(stop, "expected message_stop event");
    assert.equal(stop!.data.type, "message_stop");
  });

  it("emits message_delta with max_tokens when status is incomplete", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r6", model: "gpt-4o" },
      },
      {
        type: "response.completed",
        response: {
          status: "incomplete",
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);

    const delta = events.find((e) => e.event === "message_delta");
    assert.ok(delta);
    assert.equal(delta!.data.delta.stop_reason, "max_tokens");
  });

  // --- open text block is closed when a function_call item arrives ---
  it("closes open text block before emitting tool_use block_start", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r7", model: "gpt-4o" },
      },
      // Open text block via delta
      { type: "response.output_text.delta", delta: "thinking..." },
      // Now a function_call arrives — text block should be closed first
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call_new",
          name: "fn",
        },
      },
    ]);

    const stops = events.filter((e) => e.event === "content_block_stop");
    assert.equal(stops.length, 1, "text block should have been closed");

    const starts = events.filter((e) => e.event === "content_block_start");
    // First is the text block (auto-opened), second is the tool_use block
    assert.equal(starts.length, 2);
    assert.equal(starts[0].data.content_block.type, "text");
    assert.equal(starts[1].data.content_block.type, "tool_use");

    // The tool block index must be > text block index
    assert.ok(starts[1].data.index > starts[0].data.index);
  });

  // --- no message_stop if stream never started ---
  it("does not emit message_stop if _finish arrives before response.created", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [{ type: "_finish" }]);
    const stops = events.filter((e) => e.event === "message_stop");
    assert.equal(stops.length, 0);
  });

  // --- content_part.added also opens text block ---
  it("opens a text block on response.content_part.added", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r8", model: "gpt-4o" },
      },
      { type: "response.content_part.added" },
    ]);

    const starts = events.filter((e) => e.event === "content_block_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].data.content_block.type, "text");
  });

  // --- response.output_text.done closes the text block ---
  it("closes text block on response.output_text.done", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r9", model: "gpt-4o" },
      },
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.output_text.done" },
    ]);

    const stops = events.filter((e) => e.event === "content_block_stop");
    assert.equal(stops.length, 1);
  });

  // --- response.function_call_arguments.done closes the tool block ---
  it("closes tool block on response.function_call_arguments.done", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      {
        type: "response.created",
        response: { id: "r10", model: "gpt-4o" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_done",
          name: "fn",
        },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
      },
    ]);

    const stops = events.filter((e) => e.event === "content_block_stop");
    assert.equal(stops.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Worktree path rewriting
// ---------------------------------------------------------------------------

const MAPPING = {
  original: "/Users/x/project",
  worktree: "/Users/x/project/.claude/worktrees/agent-abc",
};

describe("translateResponse with worktree mapping", () => {
  it("rewrites file_path in function_call tool_use input", () => {
    const openaiRes = {
      id: "r1",
      model: "gpt-5.4",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "Edit",
          arguments: JSON.stringify({ file_path: "/Users/x/project/src/foo.ts", old_string: "a", new_string: "b" }),
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const { response: result } = translateResponse(openaiRes, MAPPING);
    const toolBlock = result.content.find((b: any) => b.type === "tool_use");
    assert.ok(toolBlock);
    assert.equal(toolBlock.input.file_path, "/Users/x/project/.claude/worktrees/agent-abc/src/foo.ts");
    // Non-path fields untouched
    assert.equal(toolBlock.input.old_string, "a");
  });

  it("leaves paths that do not start with original prefix unchanged", () => {
    const openaiRes = {
      id: "r2",
      model: "gpt-5.4",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_2",
          name: "Read",
          arguments: JSON.stringify({ file_path: "/other/path/file.ts" }),
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const { response: result } = translateResponse(openaiRes, MAPPING);
    const toolBlock = result.content.find((b: any) => b.type === "tool_use");
    assert.equal(toolBlock.input.file_path, "/other/path/file.ts");
  });

  it("does not rewrite when no mapping is provided", () => {
    const openaiRes = {
      id: "r3",
      model: "gpt-5.4",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_3",
          name: "Read",
          arguments: JSON.stringify({ file_path: "/Users/x/project/src/foo.ts" }),
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const { response: result } = translateResponse(openaiRes);
    const toolBlock = result.content.find((b: any) => b.type === "tool_use");
    assert.equal(toolBlock.input.file_path, "/Users/x/project/src/foo.ts");
  });
});

describe("createWsEventProcessor with worktree mapping", () => {
  it("buffers tool args and rewrites file_path on done", () => {
    const processor = createWsEventProcessor(MAPPING);
    const events = collectEvents(processor, [
      { type: "response.created", response: { id: "r4", model: "gpt-5.4" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_4", name: "Edit" },
      },
      // Two deltas that together form the full JSON
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"file_path":"/Users/x/project/sr' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: 'c/bar.ts"}' },
      { type: "response.function_call_arguments.done", output_index: 0 },
    ]);

    // With mapping: deltas are buffered, so no delta events until done
    const deltasBeforeDone = events.slice(0, events.findIndex((e) => e.event === "content_block_stop"));
    const argDeltas = deltasBeforeDone.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta");
    // Should emit exactly one delta (the rewritten complete JSON) before content_block_stop
    assert.equal(argDeltas.length, 1);
    const emitted = JSON.parse(argDeltas[0].data.delta.partial_json);
    assert.equal(emitted.file_path, "/Users/x/project/.claude/worktrees/agent-abc/src/bar.ts");
  });

  it("streams deltas normally when no mapping provided", () => {
    const processor = createWsEventProcessor();
    const events = collectEvents(processor, [
      { type: "response.created", response: { id: "r5", model: "gpt-5.4" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_5", name: "Read" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"file_path"' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: ':"x"}' },
      { type: "response.function_call_arguments.done", output_index: 0 },
    ]);

    // Without mapping: deltas emitted immediately as they arrive
    const argDeltas = events.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta");
    assert.equal(argDeltas.length, 2);
    assert.equal(argDeltas[0].data.delta.partial_json, '{"file_path"');
    assert.equal(argDeltas[1].data.delta.partial_json, ':"x"}');
  });
});
