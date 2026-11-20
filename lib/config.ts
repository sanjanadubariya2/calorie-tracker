// Build-time configuration. EXPO_PUBLIC_* variables are inlined into the
// bundle when it's built (Metro / babel-preset-expo), so they must be set in
// the build environment (.env locally, Vercel/EAS env vars for deploys);
// changing them at runtime has no effect. Keeping the reads in this one module
// also lets tests substitute values.

/** Base URL of the FastAPI backend, if any (see lib/backend.ts). */
export const RAW_API_BASE_URL: string | undefined = process.env.EXPO_PUBLIC_API_BASE_URL;
