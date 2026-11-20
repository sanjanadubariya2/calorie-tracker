// Assistant chat state: pure reducer (no network), kept in a provider above the
// navigator so conversations survive switching tabs.

import type { AssistantMessage, AssistantResponse, Conversation, FoodLogProposal, Turn } from "./assistant";

export interface ChatItem {
  key: string;
  role: "user" | "assistant";
  content: string;
  response: AssistantResponse | null;
  status: "sent" | "pending" | "failed";
  error?: { message: string; retryable: boolean };
  clientMessageId?: string;
  seq?: number;
}

export interface Thread {
  items: ChatItem[];
  nextBeforeSeq: number | null;
  loaded: boolean;
  loadingOlder: boolean;
}

export interface AssistantState {
  conversations: Conversation[];
  conversationsCursor: string | null;
  conversationsLoaded: boolean;
  activeId: string | null;       // null: a new, not-yet-created conversation
  threads: Record<string, Thread>;
  sending: Record<string, boolean>;
  authExpired: boolean;
  listError: string | null;
}

export const DRAFT = "draft";

export const initialAssistantState: AssistantState = {
  conversations: [],
  conversationsCursor: null,
  conversationsLoaded: false,
  activeId: null,
  threads: {},
  sending: {},
  authExpired: false,
  listError: null,
};

export type AssistantAction =
  | { type: "reset" }
  | { type: "conversationsLoaded"; items: Conversation[]; cursor: string | null; append: boolean }
  | { type: "listFailed"; message: string }
  | { type: "select"; id: string | null }
  | { type: "threadLoaded"; id: string; messages: AssistantMessage[]; nextBeforeSeq: number | null; older: boolean }
  | { type: "olderLoading"; id: string; loading: boolean }
  | { type: "conversationCreated"; conversation: Conversation }
  | { type: "conversationDeleted"; id: string }
  | { type: "sendStarted"; threadId: string; clientMessageId: string; content: string }
  | { type: "sendSucceeded"; threadId: string; clientMessageId: string; turn: Turn }
  | { type: "sendFailed"; threadId: string; clientMessageId: string; message: string; retryable: boolean }
  | { type: "proposalUpdated"; proposal: FoodLogProposal }
  | { type: "authExpired" };

export function fromServer(m: AssistantMessage): ChatItem {
  return {
    key: m.id, role: m.role, content: m.content, response: m.response, status: "sent",
    clientMessageId: m.client_message_id ?? undefined, seq: m.seq,
  };
}

const emptyThread = (): Thread => ({ items: [], nextBeforeSeq: null, loaded: false, loadingOlder: false });

function upsertConversation(list: Conversation[], c: Conversation): Conversation[] {
  return [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function mergeBySeq(older: ChatItem[], current: ChatItem[]): ChatItem[] {
  const seen = new Set(current.map((i) => i.key));
  return [...older.filter((i) => !seen.has(i.key)), ...current];
}

export function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case "reset":
      return initialAssistantState;
    case "conversationsLoaded":
      return {
        ...state,
        conversations: action.append ? [...state.conversations, ...action.items.filter((c) => !state.conversations.some((x) => x.id === c.id))] : action.items,
        conversationsCursor: action.cursor,
        conversationsLoaded: true,
        listError: null,
      };
    case "listFailed":
      return { ...state, listError: action.message, conversationsLoaded: true };
    case "select":
      return { ...state, activeId: action.id };
    case "threadLoaded": {
      const prev = state.threads[action.id] ?? emptyThread();
      const fetched = action.messages.map(fromServer);
      const items = action.older ? mergeBySeq(fetched, prev.items) : mergeBySeq(fetched, prev.items.filter((i) => i.status !== "sent"));
      return {
        ...state,
        threads: { ...state.threads, [action.id]: { items, nextBeforeSeq: action.nextBeforeSeq, loaded: true, loadingOlder: false } },
      };
    }
    case "olderLoading": {
      const t = state.threads[action.id] ?? emptyThread();
      return { ...state, threads: { ...state.threads, [action.id]: { ...t, loadingOlder: action.loading } } };
    }
    case "conversationCreated": {
      // A draft thread becomes the new conversation's thread.
      const draft = state.threads[DRAFT];
      const threads = { ...state.threads };
      delete threads[DRAFT];
      threads[action.conversation.id] = { ...(draft ?? emptyThread()), loaded: true };
      const sending = { ...state.sending, [action.conversation.id]: state.sending[DRAFT] ?? false };
      delete sending[DRAFT];
      return {
        ...state, threads, sending, activeId: action.conversation.id,
        conversations: upsertConversation(state.conversations, action.conversation),
      };
    }
    case "conversationDeleted": {
      const threads = { ...state.threads };
      delete threads[action.id];
      return {
        ...state, threads,
        conversations: state.conversations.filter((c) => c.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };
    }
    case "sendStarted": {
      const t = state.threads[action.threadId] ?? { ...emptyThread(), loaded: true };
      const existing = t.items.find((i) => i.clientMessageId === action.clientMessageId);
      const items = existing
        ? t.items.map((i) => (i === existing ? { ...i, status: "pending" as const, error: undefined } : i))
        : [...t.items, { key: `local-${action.clientMessageId}`, role: "user" as const, content: action.content,
            response: null, status: "pending" as const, clientMessageId: action.clientMessageId }];
      return {
        ...state,
        threads: { ...state.threads, [action.threadId]: { ...t, items } },
        sending: { ...state.sending, [action.threadId]: true },
      };
    }
    case "sendSucceeded": {
      const t = state.threads[action.threadId] ?? emptyThread();
      const items = t.items
        .filter((i) => i.clientMessageId !== action.clientMessageId && i.key !== action.turn.assistant_message.id)
        .concat([fromServer(action.turn.user_message), fromServer(action.turn.assistant_message)]);
      return {
        ...state,
        threads: { ...state.threads, [action.threadId]: { ...t, items } },
        sending: { ...state.sending, [action.threadId]: false },
        conversations: upsertConversation(state.conversations, action.turn.conversation),
      };
    }
    case "sendFailed": {
      const t = state.threads[action.threadId] ?? emptyThread();
      const items = t.items.map((i) =>
        i.clientMessageId === action.clientMessageId && i.role === "user"
          ? { ...i, status: "failed" as const, error: { message: action.message, retryable: action.retryable } }
          : i
      );
      return {
        ...state,
        threads: { ...state.threads, [action.threadId]: { ...t, items } },
        sending: { ...state.sending, [action.threadId]: false },
      };
    }
    case "proposalUpdated": {
      const threads: Record<string, Thread> = {};
      for (const [id, t] of Object.entries(state.threads)) {
        threads[id] = {
          ...t,
          items: t.items.map((i) =>
            i.response?.type === "proposed_action" && i.response.action.proposal.id === action.proposal.id
              ? { ...i, response: { ...i.response, action: { ...i.response.action, proposal: action.proposal } } }
              : i
          ),
        };
      }
      return { ...state, threads };
    }
    case "authExpired":
      return { ...state, authExpired: true };
  }
}

export function activeThread(state: AssistantState): Thread {
  return state.threads[state.activeId ?? DRAFT] ?? emptyThread();
}
