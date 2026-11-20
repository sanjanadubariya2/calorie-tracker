// The assistant tab: sending, history, rich responses, proposals, failures.
import React from "react";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as api from "@/lib/assistant";
import * as recognition from "@/lib/recognition";
import { AssistantProvider } from "@/lib/assistant-context";
import AssistantScreen from "@/app/(tabs)/assistant";
import { CONV, PROPOSAL_RESPONSE, STATUS_RESPONSE, msg, proposal, turn } from "@/lib/__fixtures__/assistant";

const mockSignOut = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ userId: "user-1", signOut: mockSignOut }) }));
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn() } }));
jest.mock("@/lib/recognition", () => ({ groundItems: jest.fn() }));
jest.mock("@/lib/assistant", () => ({
  ...jest.requireActual("@/lib/assistant"),
  assistantAvailable: jest.fn(() => true),
  listConversations: jest.fn(),
  createConversation: jest.fn(),
  deleteConversation: jest.fn(),
  listMessages: jest.fn(),
  sendMessage: jest.fn(),
  confirmProposal: jest.fn(),
  rejectProposal: jest.fn(),
  getProposal: jest.fn(),
}));

jest.setTimeout(20_000);
const m = api as jest.Mocked<typeof api>;
const { AssistantError } = jest.requireActual("@/lib/assistant") as typeof api;

let r: ReactTestRenderer;
const all = (id: string) => r.root.findAll((n) => n.props.testID === id && typeof n.type !== "string");
const byId = (id: string): ReactTestInstance => {
  const found = all(id);
  if (!found.length) throw new Error(`No element with testID ${id}`);
  return found[0];
};
const exists = (id: string) => all(id).length > 0;
// All rendered text, with adjacent pieces joined ("232" + " kcal" -> "232 kcal").
const text = (): string => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object" && "children" in node) {
      const kids = (node as { children: unknown[] | null }).children ?? [];
      if ((node as { type?: string }).type === "Text") out.push(kids.flat(Infinity).filter((k) => typeof k === "string").join(""));
      else kids.forEach(walk);
    }
  };
  walk(r.toJSON());
  return out.join(" | ");
};
const flush = () => act(async () => { await new Promise((res) => setTimeout(res, 0)); });
const press = async (id: string) => { await act(async () => { byId(id).props.onPress(); }); await flush(); };
const type = (id: string, value: string) => act(() => { byId(id).props.onChangeText(value); });

async function render() {
  await act(async () => {
    r = TestRenderer.create(<AssistantProvider><AssistantScreen /></AssistantProvider>);
  });
  await flush();
}

async function say(value: string) {
  type("composer-input", value);
  await press("composer-send");
}

beforeEach(() => {
  jest.clearAllMocks();
  m.assistantAvailable.mockReturnValue(true);
  m.listConversations.mockResolvedValue({ items: [], next_before: null });
  m.createConversation.mockResolvedValue(CONV);
  m.listMessages.mockResolvedValue({ items: [], next_before_seq: null });
});

it("quick action -> new conversation -> structured nutrition summary", async () => {
  m.sendMessage.mockImplementation(async (_c, content, cid) => turn(content, cid, STATUS_RESPONSE));
  await render();
  expect(exists("assistant-empty")).toBe(true);
  await press("quick-How many calories have I consumed today?");
  expect(m.createConversation).toHaveBeenCalledTimes(1);
  expect(m.sendMessage).toHaveBeenCalledWith(CONV.id, "How many calories have I consumed today?", expect.any(String));
  expect(exists("card-daily-status")).toBe(true);
  expect(text()).toContain("860");                       // remaining kcal from the tool result
  expect(text()).toContain("your food log");             // sources line
});

it("multiple turns keep order and reuse the conversation", async () => {
  m.sendMessage
    .mockImplementationOnce(async (_c, content, cid) => turn(content, cid, { type: "text", message: "Hello!", sources: ["general_knowledge"] }))
    .mockImplementationOnce(async (_c, content, cid) => turn(content, cid, STATUS_RESPONSE));
  await render();
  await say("hi");
  await say("how am I doing?");
  expect(m.createConversation).toHaveBeenCalledTimes(1);
  expect(m.sendMessage.mock.calls.map((c) => c[0])).toEqual([CONV.id, CONV.id]);
  const order = ["hi", "Hello!", "how am I doing?"].map((t) => text().indexOf(t));
  expect(order.every((v) => v >= 0)).toBe(true);
});

it("duplicate sends are blocked while a reply is pending", async () => {
  let finish!: (t: api.Turn) => void;
  m.sendMessage.mockImplementation((_c, content, cid) => new Promise((res) => { finish = () => res(turn(content, cid, STATUS_RESPONSE)); }));
  await render();
  type("composer-input", "first");
  const sendFn = byId("composer-send").props.onPress;
  await act(async () => { sendFn(); sendFn(); });
  await flush();
  expect(exists("assistant-thinking")).toBe(true);
  type("composer-input", "second");
  expect(byId("composer-send").props.disabled).toBe(true);
  await act(async () => { finish(turn("first", "x", STATUS_RESPONSE)); });
  await flush();
  expect(m.sendMessage).toHaveBeenCalledTimes(1);
});

it("network failure shows retry, and retry reuses the same client id", async () => {
  m.sendMessage
    .mockRejectedValueOnce(new AssistantError("Couldn't reach the server.", "network", true))
    .mockImplementationOnce(async (_c, content, cid) => turn(content, cid, STATUS_RESPONSE));
  await render();
  await say("how much protein is left?");
  expect(exists("message-error")).toBe(true);
  expect(text()).toContain("Couldn't reach the server.");
  await press("message-retry");
  const [first, second] = m.sendMessage.mock.calls;
  expect(second[2]).toBe(first[2]);                      // same client_message_id: no duplicate on the server
  expect(exists("message-error")).toBe(false);
  expect(exists("card-daily-status")).toBe(true);
});

it("an expired session shows a sign-in prompt", async () => {
  m.sendMessage.mockRejectedValueOnce(new AssistantError("Your session has expired. Sign in again.", "auth", false));
  await render();
  await say("hi");
  expect(exists("auth-expired")).toBe(true);
  expect(exists("message-retry")).toBe(false);
  await press("sign-in-again");
  expect(mockSignOut).toHaveBeenCalled();
});

it("conversation history: open, page older messages, delete", async () => {
  const older = [msg("user", "old question"), msg("assistant", "old answer")];
  const newer = [msg("user", "recent question"), msg("assistant", "recent answer")];
  m.listConversations.mockResolvedValue({ items: [CONV], next_before: null });
  m.listMessages.mockResolvedValueOnce({ items: newer, next_before_seq: newer[0].seq })
    .mockResolvedValueOnce({ items: older, next_before_seq: null });
  m.deleteConversation.mockResolvedValue(null);
  await render();
  await press("open-history");
  expect(exists(`conversation-${CONV.id}`)).toBe(true);
  await press(`conversation-${CONV.id}`);
  expect(m.listMessages).toHaveBeenCalledWith(CONV.id);
  expect(text()).toContain("recent answer");
  await act(async () => { byId("message-list").props.onEndReached(); });
  await flush();
  expect(m.listMessages).toHaveBeenLastCalledWith(CONV.id, newer[0].seq);
  expect(text()).toContain("old question");
  await press("open-history");
  await press(`conversation-delete-${CONV.id}`);
  const dialog = r.root.findAll((n) => n.props.title === "Delete conversation?" && typeof n.props.onConfirm === "function")[0];
  await act(async () => { dialog.props.onConfirm(); });
  await flush();
  expect(m.deleteConversation).toHaveBeenCalledWith(CONV.id);
  expect(exists("assistant-empty")).toBe(true);
});

it("conversation state survives leaving the screen (provider above the navigator)", async () => {
  m.sendMessage.mockImplementation(async (_c, content, cid) => turn(content, cid, STATUS_RESPONSE));
  let tree!: ReactTestRenderer;
  function App({ show }: { show: boolean }) {
    return <AssistantProvider>{show ? <AssistantScreen /> : null}</AssistantProvider>;
  }
  await act(async () => { tree = TestRenderer.create(<App show />); });
  r = tree;
  await say("hi");
  await act(async () => { tree.update(<App show={false} />); });
  await act(async () => { tree.update(<App show />); });
  expect(text()).toContain("860");
  expect(m.listMessages).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------- proposals

async function withProposal(p: api.FoodLogProposal = proposal()) {
  m.sendMessage.mockImplementation(async (_c, content, cid) => turn(content, cid, PROPOSAL_RESPONSE(p)));
  await render();
  await say("Log two boiled eggs for breakfast");
}

it("a proposal shows food, portion, nutrition and source", async () => {
  await withProposal();
  expect(exists(`proposal-${proposal().id}`)).toBe(true);
  expect(text()).toContain("Boiled egg");
  expect(text()).toContain("155 kcal");
  expect(text()).toContain("Source: INDB ASC056");
  expect(byId("proposal-quantity-0").props.value).toBe("2");
});

it("confirming logs it once, even if tapped repeatedly", async () => {
  let resolve!: (v: { proposal: api.FoodLogProposal; food_logs: api.SavedLog[] }) => void;
  m.confirmProposal.mockImplementation(() => new Promise((res) => { resolve = res; }));
  await withProposal();
  const confirm = byId("proposal-confirm").props.onPress;
  await act(async () => { confirm(); confirm(); confirm(); });
  await act(async () => {
    resolve({ proposal: proposal({ status: "confirmed", food_log_ids: ["l1"] }), food_logs: [] });
  });
  await flush();
  expect(m.confirmProposal).toHaveBeenCalledTimes(1);
  expect(m.confirmProposal).toHaveBeenCalledWith(proposal().id, { meal_type: undefined, items: undefined });
  expect(byId("proposal-status").props.children).toContain("Logged");
  expect(exists("proposal-confirm")).toBe(false);
});

it("edits are re-priced and sent with the confirmation", async () => {
  (recognition.groundItems as jest.Mock).mockResolvedValue({ items: [{ nutrition: { calories: 232, protein_g: 18.9, carbs_g: 1.7, fat_g: 15.9 } }] });
  m.confirmProposal.mockResolvedValue({ proposal: proposal({ status: "confirmed" }), food_logs: [] });
  await withProposal();
  type("proposal-quantity-0", "3");
  await act(async () => { byId("proposal-quantity-0").props.onEndEditing(); });
  await flush();
  expect(recognition.groundItems).toHaveBeenCalledWith([expect.objectContaining({ quantity: 3, unit: "piece", selected_food_id: proposal().items[0].food_id })]);
  expect(text()).toContain("232 kcal");
  await press("proposal-meal-lunch");
  await press("proposal-confirm");
  expect(m.confirmProposal).toHaveBeenCalledWith(proposal().id, { meal_type: "lunch", items: [{ index: 0, quantity: 3, unit: "piece" }] });
});

it("cancelling rejects the proposal", async () => {
  m.rejectProposal.mockResolvedValue(proposal({ status: "rejected" }));
  await withProposal();
  await press("proposal-cancel");
  expect(m.rejectProposal).toHaveBeenCalledWith(proposal().id);
  expect(byId("proposal-status").props.children).toContain("Cancelled");
  expect(m.confirmProposal).not.toHaveBeenCalled();
});

it("an expired proposal can't be confirmed", async () => {
  await withProposal(proposal({ expires_at: new Date(Date.now() - 1000).toISOString() }));
  expect(exists("proposal-confirm")).toBe(false);
  expect(byId("proposal-status").props.children).toContain("Expired");
});

it("a failed confirmation shows the error and stays confirmable", async () => {
  m.confirmProposal.mockRejectedValueOnce(new AssistantError("Couldn't save your food log. Nothing was saved; try again.", "server", true));
  await withProposal();
  await press("proposal-confirm");
  expect(byId("proposal-error").props.children).toContain("Nothing was saved");
  expect(exists("proposal-confirm")).toBe(true);
});

it("an already-logged proposal refreshes to its real status", async () => {
  m.confirmProposal.mockRejectedValueOnce(new AssistantError("This proposal was already logged.", "conflict", false));
  m.getProposal.mockResolvedValueOnce(proposal({ status: "confirmed" }));
  await withProposal();
  await press("proposal-confirm");
  expect(m.getProposal).toHaveBeenCalledWith(proposal().id);
  expect(byId("proposal-status").props.children).toContain("Logged");
});

it("clarification options are sent as replies", async () => {
  m.sendMessage
    .mockImplementationOnce(async (_c, content, cid) => turn(content, cid, {
      type: "clarification", message: "Which dal?", sources: ["catalogue"], options: ["Moong dal", "Mixed dal"], food_issues: [] }))
    .mockImplementationOnce(async (_c, content, cid) => turn(content, cid, STATUS_RESPONSE));
  await render();
  await say("log dal");
  await press("option-Mixed dal");
  expect(m.sendMessage).toHaveBeenLastCalledWith(CONV.id, "Mixed dal", expect.any(String));
});

it("without a backend the tab explains it's unavailable", async () => {
  m.assistantAvailable.mockReturnValue(false);
  await render();
  expect(exists("assistant-unavailable")).toBe(true);
  expect(m.listConversations).not.toHaveBeenCalled();
});
