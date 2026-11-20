// Runs once in the parent Jest process before any test worker starts (see
// "globalSetup" in package.json). Each test file gets its own copy of
// process.env, so TZ can't be changed reliably from inside a test.
//
// Pinning a DST-observing zone makes date tests deterministic on every machine
// and CI runner, and exercises the 23- and 25-hour days that naive
// millisecond arithmetic gets wrong.
module.exports = async () => {
  process.env.TZ = "America/New_York";
};
