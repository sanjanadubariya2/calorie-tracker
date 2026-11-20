// Assistant state for the whole app (mounted in app/_layout.tsx), so switching
// tabs keeps the open conversation, its messages and any pending reply.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { useAuth } from "./auth-context";
import * as api from "./assistant";
import { AssistantError, type FoodLogProposal, type ItemEdit, type SavedLog } from "./assistant";
import { DRAFT, assistantReducer, initialAssistantState, type AssistantState } from "./assistantState";

interface AssistantContextValue {
  state: AssistantState;
  available: boolean;
  loadConversations: (more?: boolean) => Promise<void>;
  openConversation: (id: string | null) => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  confirm: (proposalId: string, edits: { meal_type?: string; items?: ItemEdit[] }) => Promise<SavedLog[]>;
  reject: (proposalId: string) => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [state, dispatch] = useReducer(assistantReducer, initialAssistantState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(new Set<string>());       // synchronous duplicate-request guard

  // A different (or no) user never sees the previous user's conversations.
  useEffect(() => {
    dispatch({ type: "reset" });
    inFlight.current.clear();
  }, [userId]);

  const guard = useCallback(<T,>(error: unknown): T => {
    const e = api.toAssistantError(error);
    if (e.kind === "auth") dispatch({ type: "authExpired" });
    throw e;
  }, []);

  const once = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    try {
      return await fn();
    } finally {
      inFlight.current.delete(key);
    }
  }, []);

  const loadConversations = useCallback(async (more = false) => {
    await once("list", async () => {
      try {
        const page = await api.listConversations(more ? stateRef.current.conversationsCursor ?? undefined : undefined);
        dispatch({ type: "conversationsLoaded", items: page.items, cursor: page.next_before, append: more });
      } catch (error) {
        const e = api.toAssistantError(error);
        if (e.kind === "auth") dispatch({ type: "authExpired" });
        dispatch({ type: "listFailed", message: e.message });
      }
    });
  }, [once]);

  const openConversation = useCallback(async (id: string | null) => {
    dispatch({ type: "select", id });
    if (id === null || stateRef.current.threads[id]?.loaded) return;
    await once(`open:${id}`, async () => {
      try {
        const page = await api.listMessages(id);
        dispatch({ type: "threadLoaded", id, messages: page.items, nextBeforeSeq: page.next_before_seq, older: false });
      } catch (error) {
        guard(error);
      }
    });
  }, [guard, once]);

  const loadOlder = useCallback(async () => {
    const id = stateRef.current.activeId;
    const thread = id ? stateRef.current.threads[id] : undefined;
    if (!id || !thread?.nextBeforeSeq) return;
    await once(`older:${id}`, async () => {
      dispatch({ type: "olderLoading", id, loading: true });
      try {
        const page = await api.listMessages(id, thread.nextBeforeSeq ?? undefined);
        dispatch({ type: "threadLoaded", id, messages: page.items, nextBeforeSeq: page.next_before_seq, older: true });
      } catch (error) {
        dispatch({ type: "olderLoading", id, loading: false });
        guard(error);
      }
    });
  }, [guard, once]);

  const removeConversation = useCallback(async (id: string) => {
    try {
      await api.deleteConversation(id);
    } catch (error) {
      if (!(error instanceof AssistantError && error.kind === "not_found")) guard(error);
    }
    dispatch({ type: "conversationDeleted", id });
  }, [guard]);

  const deliver = useCallback(async (threadId: string, clientMessageId: string, content: string) => {
    await once(`send:${threadId}`, async () => {
      dispatch({ type: "sendStarted", threadId, clientMessageId, content });
      let target = threadId;                                // the thread the message lives in now
      try {
        if (threadId === DRAFT) {
          const conversation = await api.createConversation();
          dispatch({ type: "conversationCreated", conversation });
          target = conversation.id;
        }
        const turn = await api.sendMessage(target, content, clientMessageId);
        dispatch({ type: "sendSucceeded", threadId: target, clientMessageId, turn });
      } catch (error) {
        const e = api.toAssistantError(error);
        if (e.kind === "auth") dispatch({ type: "authExpired" });
        dispatch({ type: "sendFailed", threadId: target, clientMessageId, message: e.message, retryable: e.retryable });
      }
    });
  }, [once]);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content) return;
    const threadId = stateRef.current.activeId ?? DRAFT;
    if (stateRef.current.sending[threadId]) return;          // one reply at a time per conversation
    await deliver(threadId, api.newClientMessageId(), content);
  }, [deliver]);

  const retry = useCallback(async (clientMessageId: string) => {
    const threadId = stateRef.current.activeId ?? DRAFT;
    const item = stateRef.current.threads[threadId]?.items.find((i) => i.clientMessageId === clientMessageId);
    if (!item || item.status !== "failed") return;
    await deliver(threadId, clientMessageId, item.content);   // same id: the server won't duplicate it
  }, [deliver]);

  const confirm = useCallback(async (proposalId: string, edits: { meal_type?: string; items?: ItemEdit[] }) => {
    const result = await once(`proposal:${proposalId}`, async () => {
      try {
        return await api.confirmProposal(proposalId, edits);
      } catch (error) {
        const e = api.toAssistantError(error);
        if (e.kind === "conflict" || e.kind === "gone") {
          // Already logged / cancelled / expired elsewhere: show its real status.
          await api.getProposal(proposalId).then((p) => dispatch({ type: "proposalUpdated", proposal: p })).catch(() => {});
        }
        return guard<never>(e);
      }
    });
    if (!result) return [];                                    // a confirmation is already in progress
    dispatch({ type: "proposalUpdated", proposal: result.proposal });
    return result.food_logs;
  }, [guard, once]);

  const reject = useCallback(async (proposalId: string) => {
    const proposal = await once(`proposal:${proposalId}`, async () => {
      try {
        return await api.rejectProposal(proposalId);
      } catch (error) {
        return guard<never>(error);
      }
    });
    if (proposal) dispatch({ type: "proposalUpdated", proposal: proposal as FoodLogProposal });
  }, [guard, once]);

  const value = useMemo<AssistantContextValue>(() => ({
    state, available: api.assistantAvailable(), loadConversations, openConversation, removeConversation, send, retry,
    loadOlder, confirm, reject,
  }), [state, loadConversations, openConversation, removeConversation, send, retry, loadOlder, confirm, reject]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}
