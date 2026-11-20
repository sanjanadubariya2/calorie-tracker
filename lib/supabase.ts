import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

// MOCK_MODE lets the whole app run against in-memory fake data with zero
// backend setup — useful while building the UI before Supabase is wired up.
// Mirrors the VITE_MOCK=1 pattern used elsewhere: flip the env var, not the code.
export const MOCK_MODE =
  process.env.EXPO_PUBLIC_MOCK_MODE === "true" || !supabaseUrl || !supabaseAnonKey;

// In mock mode we still construct a harmless client (never called) so any
// direct `import { supabase }` usage elsewhere doesn't crash at import time.
// Typed against lib/database.types.ts, generated from supabase/migrations by
// `npm run types:gen`. Regenerate after every migration.
export const supabase = createClient<Database>(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-anon-key",
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);
