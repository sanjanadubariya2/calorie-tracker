// https://docs.expo.dev/guides/using-eslint/
module.exports = {
  root: true,
  extends: ["expo"],
  ignorePatterns: ["/dist/*", "/node_modules/*", "/.expo/*", "/supabase/*", "lib/database.types.ts", "/backend/*"],
  overrides: [
    {
      // Jest globals for test files and the setup file.
      files: ["**/__tests__/**/*.[jt]s?(x)", "**/*.test.[jt]s?(x)", "jest.setup.js", "jest.global-setup.js"],
      env: { jest: true },
    },
  ],
};
