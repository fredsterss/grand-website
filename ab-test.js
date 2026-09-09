(function setupGrandWaitlistAbTest(window, document) {
  "use strict";

  // Homepage waitlist A/B test: does asking for a phone number up front cost us
  // signups compared with asking for an email? The two arms differ in exactly
  // one thing — which identifier the homepage form asks for. Whichever one the
  // visitor did not give is then offered on welcome.html, optionally.
  const VARIANTS = ["phone", "email"];
  // Assignment is scoped to the browser session, deliberately matching
  // PostHog's cookieless_mode identity so the unit of randomization and the
  // unit of analysis are the same thing. It also avoids introducing any new
  // persistent storage, so the privacy posture described in privacy.html is
  // unchanged. Known trade-off: a returning visitor in a new session can be
  // re-rolled, so results must be read at session level, never per person.
  const VARIANT_STORAGE_KEY = "grand_waitlist_variant";
  const SIGNUP_PHONE_KEY = "grand_signup_phone";
  const SIGNUP_EMAIL_KEY = "grand_signup_email";
  // The control arm, and the fallback whenever anything below fails, so a
  // broken or blocked script degrades to the form that is live today rather
  // than to no form at all.
  const DEFAULT_VARIANT = VARIANTS[0];

  function readSessionValue(key) {
    try {
      return window.sessionStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function isVariant(value) {
    return VARIANTS.indexOf(String(value || "")) >= 0;
  }

  function isProfilePage() {
    return /(^|\/)welcome\.html$/.test(window.location.pathname);
  }

  // QA and demo override only: /?variant=email. Deliberately not a way to split
  // paid traffic — pointing one ad at ?variant=email would make the variant a
  // function of campaign, creative and audience, which is not a randomized test
  // any more, just a comparison of two ad sets.
  function readVariantOverride() {
    try {
      const variant = new URLSearchParams(window.location.search).get("variant");
      return isVariant(variant) ? variant : "";
    } catch {
      return "";
    }
  }

  function rollVariant() {
    // crypto, not Math.random: a weak PRNG would bias assignment, which is the
    // one thing this whole test depends on being fair.
    if (typeof window.crypto?.getRandomValues !== "function") return DEFAULT_VARIANT;

    return VARIANTS[window.crypto.getRandomValues(new Uint8Array(1))[0] % VARIANTS.length];
  }

  function resolveVariant() {
    const override = readVariantOverride();
    if (override) {
      // Persisted so the override survives the navigation to welcome.html,
      // which drops the query string.
      try {
        window.sessionStorage.setItem(VARIANT_STORAGE_KEY, override);
      } catch {}
      return override;
    }

    const storedVariant = readSessionValue(VARIANT_STORAGE_KEY);
    if (isVariant(storedVariant)) return storedVariant;

    // welcome.html never assigns. Someone landing there directly, in a new tab,
    // or with storage blocked must not be re-rolled: that would fire a second,
    // contradictory exposure event and poison the funnel's variant attribution.
    // An empty variant is the honest answer in that case — we genuinely do not
    // know which form they saw, so we would rather log nothing than guess.
    if (isProfilePage()) return "";

    const variant = rollVariant();
    try {
      window.sessionStorage.setItem(VARIANT_STORAGE_KEY, variant);
    } catch {}
    return variant;
  }

  // Which contact method welcome.html should offer: whatever the signup did not
  // already capture. Derived from what is actually in storage rather than from
  // the variant, so it stays correct even when the two disagree — direct entry,
  // a cleared session, or an override switched mid-session. Neither field is
  // ever required, so "both" is a safe answer rather than a dead end.
  function resolveProfileAsk() {
    const hasPhone = Boolean(readSessionValue(SIGNUP_PHONE_KEY));
    const hasEmail = Boolean(readSessionValue(SIGNUP_EMAIL_KEY));

    if (hasPhone && !hasEmail) return "email";
    if (hasEmail && !hasPhone) return "phone";
    return "both";
  }

  const variant = resolveVariant();
  const profileAsk = resolveProfileAsk();

  // Written to <html> from a synchronous <head> script so the stylesheet can
  // hide the unused field before the first paint. Toggling visibility from JS
  // after load would flash both fields for a frame.
  document.documentElement.dataset.waitlistVariant = variant || DEFAULT_VARIANT;
  document.documentElement.dataset.profileAsk = profileAsk;

  // Read by script.js (to wire up the surviving field and tag every analytics
  // event) and by posthog.js (to tag every PostHog event).
  window.grandWaitlistVariant = variant;
  window.grandProfileAsk = profileAsk;
})(window, document);
