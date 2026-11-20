// Global Jest setup (see "jest" in package.json).

// AsyncStorage has no native module under Jest; use the package's own in-memory mock.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// Unit tests must never reach a real Supabase project. Jest doesn't load .env,
// and these blanks make lib/supabase.ts build its inert placeholder client and
// switch MOCK_MODE on, so any lib/api.ts or lib/social.ts call a test makes
// goes to the in-memory mock store rather than the network.
process.env.EXPO_PUBLIC_SUPABASE_URL = "";
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "";
process.env.EXPO_PUBLIC_MOCK_MODE = "true";
