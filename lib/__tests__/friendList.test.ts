// Friend list client (migration 027): the new RPC, and nothing private kept even if a server sent it.
import { supabase } from "../supabase";
import { getFriendSummaries } from "../social";

jest.mock("../supabase", () => ({ MOCK_MODE: false, supabase: { rpc: jest.fn() } }));
const rpc = supabase.rpc as unknown as jest.Mock;

it("uses get_friend_list and keeps only identity and a shared streak", async () => {
  rpc.mockResolvedValue({ data: [
    { user_id: "f1", username: "meera", avatar_url: null, current_streak: 4, today_kcal: 1200, daily_target_kcal: 1800 },
    { user_id: "f2", username: "priya", avatar_url: null, current_streak: null },
  ], error: null });
  const list = await getFriendSummaries();
  expect(rpc).toHaveBeenCalledWith("get_friend_list");
  expect(list).toEqual([
    { user_id: "f1", username: "meera", avatar_url: null, current_streak: 4 },
    { user_id: "f2", username: "priya", avatar_url: null, current_streak: null },
  ]);
  expect(JSON.stringify(list)).not.toMatch(/kcal/);
});
