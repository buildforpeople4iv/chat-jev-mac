/**
 * Contract 1 — the conversation snapshot every message source produces.
 *
 * Site adapters and the macOS WeChat reader both emit this shape; nothing
 * downstream knows where a snapshot came from. See the spec, section 4.
 */

export interface ChatMessage {
  id: string;
  text: string;
  sender?: string;
  /** true = mine, false = theirs, null = direction unconfirmed (never a reply target) */
  isSelf: boolean | null;
  ts: number;
  mentionsMe: boolean;
}

export interface ConversationSnapshot {
  source: string;
  conversationId: string;
  title: string;
  isGroup: boolean;
  messages: ChatMessage[];
  input: { canFill: boolean };
}

/**
 * A stable id for sites that do not give messages one of their own: content plus
 * position. Position matters — the same "ok" sent twice is two messages, and
 * deduplication must not collapse them.
 *
 * `index` must be counted from the **end** of the list (`rows.length - 1 - i`),
 * not from its start. Slack, Discord and Teams virtualize their message lists:
 * rows that scroll off the top are removed from the DOM, so distance-from-the-
 * start changes for every surviving row while distance-from-the-end does not.
 * An id that moves under scrolling defeats the whole point — see the callers,
 * and scheduler/decide.ts's `analyzedId`.
 */
export function messageId(text: string, index: number, sender?: string): string {
  const basis = `${index}\u0000${sender ?? ""}\u0000${text}`;
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

type Result =
  | { ok: true; snapshot: ConversationSnapshot }
  | { ok: false; error: string };

export function validateSnapshot(value: unknown): Result {
  if (typeof value !== "object" || value === null) return { ok: false, error: "not an object" };
  const v = value as Record<string, unknown>;
  for (const key of ["source", "conversationId", "title"]) {
    if (typeof v[key] !== "string") return { ok: false, error: `${key} must be a string` };
  }
  if (typeof v["isGroup"] !== "boolean") return { ok: false, error: "isGroup must be a boolean" };
  if (!Array.isArray(v["messages"])) return { ok: false, error: "messages must be an array" };
  for (const [i, m] of (v["messages"] as unknown[]).entries()) {
    if (typeof m !== "object" || m === null) return { ok: false, error: `messages[${i}] not an object` };
    const msg = m as Record<string, unknown>;
    if (typeof msg["id"] !== "string") return { ok: false, error: `messages[${i}].id must be a string` };
    if (typeof msg["text"] !== "string") return { ok: false, error: `messages[${i}].text must be a string` };
    if (!(msg["isSelf"] === true || msg["isSelf"] === false || msg["isSelf"] === null)) {
      return { ok: false, error: `messages[${i}].isSelf must be true, false or null` };
    }
    if (typeof msg["ts"] !== "number" || Number.isNaN(msg["ts"])) {
      return { ok: false, error: `messages[${i}].ts must be a number` };
    }
    if (typeof msg["mentionsMe"] !== "boolean") {
      return { ok: false, error: `messages[${i}].mentionsMe must be a boolean` };
    }
  }
  const input = v["input"] as Record<string, unknown> | undefined;
  if (!input || typeof input["canFill"] !== "boolean") {
    return { ok: false, error: "input.canFill must be a boolean" };
  }
  return { ok: true, snapshot: value as ConversationSnapshot };
}

/**
 * The reply target: the last message that is definitely from someone else.
 * `isSelf: null` is deliberately excluded — the spec's conservative rule, inherited
 * from perception.message_side(): better to miss a message than to answer myself.
 */
export function newestIncoming(s: ConversationSnapshot): ChatMessage | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    if (m.isSelf === false) return m;
  }
  return null;
}
