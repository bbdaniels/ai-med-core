// Preload: node --import <this file> ...
//
// When AI_MED_TEST_NOW is set (an ISO instant), `new Date()` and `Date.now()`
// start at that instant and keep ticking at real speed from there. Prompts that
// carry today's date are then reproducible, while rate limiters, JWT expiry and
// timeouts, which measure elapsed time, behave as they do in production.
// Dates built from explicit arguments (`new Date(0)`, `Date.parse`, `Date.UTC`)
// are untouched. The harness also sets TZ=UTC, so date formatting is stable.
const raw = process.env.AI_MED_TEST_NOW;
if (raw && raw.trim()) {
  const RealDate = globalThis.Date;
  const target = RealDate.parse(raw.trim());
  if (Number.isNaN(target)) {
    throw new Error(`AI_MED_TEST_NOW is not a parseable date: ${raw}`);
  }
  const offset = target - RealDate.now();
  const shiftedNow = () => RealDate.now() + offset;

  class FixedClockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(shiftedNow());
      else super(...args);
    }
    static now() {
      return shiftedNow();
    }
  }
  // Called without `new`, Date() returns a string for the current time.
  const DateShim = new Proxy(FixedClockDate, {
    apply() {
      return new RealDate(shiftedNow()).toString();
    },
  });
  globalThis.Date = DateShim;
}
