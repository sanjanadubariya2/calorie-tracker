// lib/assistantState.ts: chat state transitions.
import { DRAFT, activeThread, assistantReducer, initialAssistantState, type AssistantState } from "../assistantState";
import { CONV, PROPOSAL_RESPONSE, STATUS_RESPONSE, msg, proposal, turn } from "../__fixtures__/assistant";

const send = (s: AssistantState, threadId: string, id: string, content: string) =>
  assistantReducer(s, { type: "sendStarted", threadId, clientMessageId: id, content });

it("a first message lives in a draft until the conversation is created", () => {
  let s = send(initialAssistantState, DRAFT, "cm1", "How many calories?");
  expect(activeThread(s).items.map((i) => [i.content, i.status])).toEqual([["How many calories?", "pending"]]);
  expect(s.sending[DRAFT]).toBe(true);
  s = assistantReducer(s, { type: "conversationCreated", conversation: CONV });
  expect(s.activeId).toBe(CONV.id);
  expect(s.threads[DRAFT]).toBeUndefined();
  expect(activeThread(s).items).toHaveLength(1);
  s = assistantReducer(s, { type: "sendSucceeded", threadId: CONV.id, clientMessageId: "cm1", turn: turn("How many calories?", "cm1", STATUS_RESPONSE) });
  expect(activeThread(s).items.map((i) => [i.role, i.status])).toEqual([["user", "sent"], ["assistant", "sent"]]);
  expect(s.sending[CONV.id]).toBe(false);
  expect(s.conversations[0].id).toBe(CONV.id);
});

it("a failed send can be retried with the same client id, without duplicating the message", () => {
  let s = assistantReducer(initialAssistantState, { type: "select", id: CONV.id });
  s = send(s, CONV.id, "cm2", "Hi");
  s = assistantReducer(s, { type: "sendFailed", threadId: CONV.id, clientMessageId: "cm2", message: "No connection", retryable: true });
  expect(activeThread(s).items[0]).toMatchObject({ status: "failed", error: { message: "No connection", retryable: true } });
  s = send(s, CONV.id, "cm2", "Hi");
  expect(activeThread(s).items).toHaveLength(1);
  expect(activeThread(s).items[0].status).toBe("pending");
});

it("older pages are prepended without duplicates", () => {
  const newer = [msg("user", "q3"), msg("assistant", "a3")];
  const older = [msg("user", "q1"), msg("assistant", "a1"), newer[0]];
  let s = assistantReducer(initialAssistantState, { type: "threadLoaded", id: CONV.id, messages: newer, nextBeforeSeq: newer[0].seq, older: false });
  s = assistantReducer(s, { type: "select", id: CONV.id });
  s = assistantReducer(s, { type: "threadLoaded", id: CONV.id, messages: older, nextBeforeSeq: null, older: true });
  expect(activeThread(s).items.map((i) => i.content)).toEqual(["q1", "a1", "q3", "a3"]);
  expect(activeThread(s).nextBeforeSeq).toBeNull();
});

it("proposal updates reach the card wherever it is", () => {
  let s = assistantReducer(initialAssistantState, { type: "threadLoaded", id: CONV.id, nextBeforeSeq: null, older: false,
    messages: [msg("assistant", "Tap Confirm", PROPOSAL_RESPONSE())] });
  s = assistantReducer(s, { type: "proposalUpdated", proposal: proposal({ status: "confirmed", food_log_ids: ["l1"] }) });
  const r = s.threads[CONV.id].items[0].response;
  expect(r?.type === "proposed_action" && r.action.proposal.status).toBe("confirmed");
});

it("deleting the open conversation returns to a new one; reset clears everything", () => {
  let s = assistantReducer(initialAssistantState, { type: "conversationsLoaded", items: [CONV], cursor: null, append: false });
  s = assistantReducer(s, { type: "select", id: CONV.id });
  s = assistantReducer(s, { type: "conversationDeleted", id: CONV.id });
  expect(s.activeId).toBeNull();
  expect(s.conversations).toEqual([]);
  s = assistantReducer(s, { type: "authExpired" });
  expect(assistantReducer(s, { type: "reset" })).toEqual(initialAssistantState);
});
