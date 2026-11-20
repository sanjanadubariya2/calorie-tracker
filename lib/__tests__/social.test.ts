// Pure helpers from lib/social.ts. The authorization rules themselves are
// enforced by the database and tested in supabase/tests/003_social_security.test.sql.
import {
  SOCIAL_ERROR,
  USERNAME_PATTERN,
  describeSocialError,
  normalizeUsername,
  validateUsername,
} from "../social";

describe("normalizeUsername", () => {
  it("trims, lower-cases, and drops a leading @", () => {
    expect(normalizeUsername("  @Sanj_99 ")).toBe("sanj_99");
  });
  it("drops only one leading @", () => {
    expect(normalizeUsername("@@x")).toBe("@x");
  });
});

describe("validateUsername", () => {
  it.each(["abc", "a_1", "user_name_twenty_ch", "ABC", "@Mixed_Case"])("accepts %p", (name) => {
    expect(validateUsername(name)).toBeNull();
  });

  it.each([
    ["ab", "at least 3"],
    ["a".repeat(21), "20 characters or fewer"],
    ["has space", "letters, numbers, and underscores"],
    ["dot.name", "letters, numbers, and underscores"],
    ["émile", "letters, numbers, and underscores"],
  ])("rejects %p", (name, message) => {
    expect(validateUsername(name)).toContain(message);
  });

  it("matches the database CHECK (profiles_username_format in migration 003)", () => {
    expect(USERNAME_PATTERN.source).toBe("^[a-z0-9_]{3,20}$");
  });
});

describe("describeSocialError", () => {
  it.each([
    [SOCIAL_ERROR.requestNotFound, "no longer exists"],
    [SOCIAL_ERROR.requestNotPending, "already been answered"],
    [SOCIAL_ERROR.duplicateRequest, "already a request"],
    [SOCIAL_ERROR.notAuthenticated, "signed out"],
  ])("maps SQLSTATE %s", (code, text) => {
    expect(describeSocialError({ code, message: "x" })).toContain(text);
  });

  it("falls back to a generic message for unknown errors and non-objects", () => {
    expect(describeSocialError(new Error("boom"))).toContain("Something went wrong");
    expect(describeSocialError(null)).toContain("Something went wrong");
    expect(describeSocialError("nope")).toContain("Something went wrong");
  });

  it("uses the SQLSTATE codes raised by the migration", () => {
    expect(SOCIAL_ERROR).toEqual({
      notAuthenticated: "28000",
      invalidArgument: "22023",
      requestNotFound: "P0002",
      requestNotPending: "55000",
      duplicateRequest: "23505",
    });
  });
});
