// Interactions client: request shapes (never an acting user id), comment
// validation mirroring comment_body_ok, optimistic reaction math, messages.
// Ownership, RLS, blocks and rate limits: supabase/tests/023_social_interactions.test.sql.
import { supabase } from "../supabase";
import {
  EMPTY_INTERACTIONS,
  addComment,
  applyReaction,
  describeInteractionError,
  getInteractions,
  removeReaction,
  reportContent,
  setReaction,
  validateComment,
} from "../interactions";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

it("reactions, comments and reports send only ids and content, never who is acting", async () => {
  await setReaction("e1", "fire");
  await removeReaction("e1");
  await addComment("e1", "  Nice work!  ");
  await reportContent("comment", "c1", "spam");
  expect(rpc.mock.calls).toEqual([
    ["set_reaction", { p_event: "e1", p_reaction: "fire" }],
    ["remove_reaction", { p_event: "e1" }],
    ["add_comment", { p_event: "e1", p_body: "Nice work!" }],
    ["report_content", { p_kind: "comment", p_target: "c1", p_reason: "spam", p_note: null }],
  ]);
});

it("rejects invalid comments before calling the server", async () => {
  await expect(addComment("e1", "   ")).rejects.toMatchObject({ code: "22023" });
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  ["", false], ["   ", false], ["ok", true], ["x".repeat(280), true], ["x".repeat(281), false],
  ["bell\u0007", false], ["tab\there", false], ["1\n2\n3\n4", true], ["1\n2\n3\n4\n5", false], ["🎉".repeat(280), true],
])("validateComment(%j) ok=%s", (input, ok) => {
  expect(validateComment(input).ok).toBe(ok);
});

it("maps counts and ignores unknown reactions from the server", async () => {
  rpc.mockResolvedValue({ data: [{ event_id: "e1", like_count: "2", celebrate_count: 0, support_count: 1, fire_count: 0,
                                   my_reaction: "angry", comment_count: "3" }], error: null });
  expect(await getInteractions(["e1"])).toEqual({
    e1: { counts: { like: 2, celebrate: 0, support: 1, fire: 0 }, mine: null, comments: 3 },
  });
  rpc.mockClear();
  expect(await getInteractions([])).toEqual({});
  expect(rpc).not.toHaveBeenCalled();
});

it("applyReaction moves my reaction without double counting", () => {
  const liked = applyReaction(EMPTY_INTERACTIONS, "like");
  expect(liked.counts.like).toBe(1);
  const fired = applyReaction(liked, "fire");
  expect([fired.counts.like, fired.counts.fire, fired.mine]).toEqual([0, 1, "fire"]);
  const removed = applyReaction(fired, null);
  expect([removed.counts.fire, removed.mine]).toEqual([0, null]);
});

it("error messages", () => {
  expect(describeInteractionError({ code: "P0429" })).toMatch(/a bit fast/);
  expect(describeInteractionError({ code: "P0002" })).toMatch(/isn't available/);
  expect(describeInteractionError({ code: "22023", message: "You can't react to your own activity" }))
    .toBe("You can't react to your own activity.");
});
