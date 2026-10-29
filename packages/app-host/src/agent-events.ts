export type AgentKind = "claude" | "codex";
export interface ChatEvent {
  type: "user" | "text" | "tool_start" | "tool_end" | "end" | "error" | "session" | "log";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// CLI protocols evolve independently; unknown records remain diagnostic events.
export function agentParser(agent: AgentKind, emit: (event: ChatEvent) => void) {
  const texts = new Map<string, string>();
  const tools = new Map<unknown, { id: string; input: string }>();
  let streamed = false;
  const startTool = (block: Record<string, unknown>) => {
    if (typeof block.id === "string")
      emit({
        type: "tool_start",
        id: block.id,
        ...(typeof block.name === "string" ? { name: block.name } : {}),
        input: block.input,
      });
  };
  return (line: string) => {
    let e: Record<string, unknown>;
    try {
      e = record(JSON.parse(line));
    } catch {
      emit({ type: "log", text: "Invalid agent JSON" });
      return;
    }
    if (agent === "claude") {
      if (e.type === "system" && typeof e.session_id === "string") emit({ type: "session", id: e.session_id });
      else if (e.type === "stream_event") {
        const event = record(e.event);
        const delta = record(event.delta);
        const block = record(event.content_block);
        if (event.type === "message_start") streamed = false;
        if (event.type === "content_block_delta" && typeof delta.text === "string") {
          streamed = true;
          emit({ type: "text", text: delta.text });
        } else if (event.type === "content_block_start" && block.type === "tool_use") {
          if (typeof block.id === "string") {
            tools.set(event.index, { id: block.id, input: "" });
            startTool(block);
          }
        } else if (event.type === "content_block_delta" && typeof delta.partial_json === "string") {
          const tool = tools.get(event.index);
          if (tool) {
            tool.input += delta.partial_json;
            emit({ type: "tool_start", id: tool.id, input: tool.input });
          }
        } else if (
          !["message_start", "content_block_stop", "message_delta", "message_stop"].includes(String(event.type))
        ) {
          emit({ type: "log", text: `Ignored Claude stream event: ${String(event.type)}` });
        }
      } else if (e.type === "assistant" && Array.isArray(record(e.message).content)) {
        for (const value of record(e.message).content as unknown[]) {
          const block = record(value);
          if (block.type === "text" && !streamed && typeof block.text === "string")
            emit({ type: "text", text: block.text });
          if (block.type === "tool_use") startTool(block);
        }
        streamed = false;
      } else if (e.type === "user" && Array.isArray(record(e.message).content)) {
        for (const value of record(e.message).content as unknown[]) {
          const block = record(value);
          if (block.type === "tool_result" && typeof block.tool_use_id === "string")
            emit({ type: "tool_end", id: block.tool_use_id, input: block.content });
        }
      } else if (e.type === "result") {
        if (e.is_error)
          emit({
            type: "error",
            text: Array.isArray(e.errors) ? e.errors.join("\n") : String(e.result ?? "Agent failed"),
          });
        emit({ type: "end" });
      } else emit({ type: "log", text: `Ignored Claude event: ${String(e.type)}` });
    } else {
      const item = record(e.item);
      if (e.type === "thread.started" && typeof e.thread_id === "string") emit({ type: "session", id: e.thread_id });
      else if (typeof e.type === "string" && ["item.started", "item.updated", "item.completed"].includes(e.type)) {
        if (item.type === "agent_message" && typeof item.text === "string") {
          const key = String(item.id ?? "message");
          const previous = texts.get(key) ?? "";
          if (item.text.startsWith(previous)) emit({ type: "text", text: item.text.slice(previous.length) });
          texts.set(key, item.text);
        } else if (item.type === "mcp_tool_call" && typeof item.id === "string") {
          startTool({ id: item.id, name: item.tool, input: item.arguments });
          if (e.type === "item.completed") emit({ type: "tool_end", id: item.id, input: item.result ?? item.error });
        } else emit({ type: "log", text: `Ignored Codex item: ${String(item.type)}` });
      } else if (e.type === "turn.completed") emit({ type: "end" });
      else if (e.type === "error" || e.type === "turn.failed")
        emit({ type: "error", text: String(e.message ?? record(e.error).message ?? "Agent failed") });
      else emit({ type: "log", text: `Ignored Codex event: ${String(e.type)}` });
    }
  };
}
