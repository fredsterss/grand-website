const waitlistForm = document.querySelector("[data-waitlist-form]");
const profileForm = document.querySelector("[data-profile-form]");
const analyticsEndpoint =
  (waitlistForm || profileForm)?.dataset.waitlistEndpoint?.trim() || "";
// Grand's alpha signup collects a phone number instead of an email. Tagging
// every payload routes this product's signups/profiles/events into their own
// spreadsheet tabs, keeping them a clean break from the historical email data.
const PRODUCT = "grandphone";
const trackedSections = ["problem", "system", "attention", "tracking", "response", "waitlist"];
const anchorScrollRetries = [0, 120, 360, 760];
let fallbackSessionId = "";
let cachedGeoLocation = null;
let cachedUserAgentData = null;

// Best-effort, non-blocking IP geolocation. Kicked off on load (homepage only)
// so a coarse location is usually ready by the time the visitor submits. We
// never block or fail a signup on this — see buildWaitlistPayload.
if (waitlistForm) {
  fetchGeoLocation()
    .then((geo) => {
      cachedGeoLocation = geo;
    })
    .catch(() => {});
  getUserAgentData()
    .then((userAgentData) => {
      cachedUserAgentData = userAgentData;
    })
    .catch(() => {});
}

function getSessionId() {
  const key = "grand_analytics_session_id";

  try {
    const storedSessionId = window.sessionStorage.getItem(key);
    if (storedSessionId) return storedSessionId;

    const sessionId = createSessionId();
    window.sessionStorage.setItem(key, sessionId);
    return sessionId;
  } catch {
    if (!fallbackSessionId) fallbackSessionId = createSessionId();
    return fallbackSessionId;
  }
}

function createSessionId() {
  return window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// One exposure per session, not per page load — see the call site. Marks the
// session as counted and reports whether it already was. Storage failures fall
// back to logging the exposure: an over-count is a worse outcome than a missing
// one only when it is silent, and a browser with no sessionStorage also has no
// sticky variant, so each of its page loads genuinely is a fresh assignment.
function hasLoggedVariantExposure() {
  const key = "grand_waitlist_exposure_logged";

  try {
    if (window.sessionStorage.getItem(key)) return true;
    window.sessionStorage.setItem(key, "1");
  } catch {}

  return false;
}

function getViewportPayload() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function getCurrentSectionId() {
  const sections = trackedSections
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const midpoint = window.innerHeight / 2;

  return (
    sections.find((section) => {
      const rect = section.getBoundingClientRect();
      return rect.top <= midpoint && rect.bottom >= midpoint;
    })?.id || "top"
  );
}

function trackAnalyticsEvent(eventType, details = {}) {
  if (!analyticsEndpoint) return;

  const payload = {
    type: "analytics_event",
    product: PRODUCT,
    event_type: eventType,
    event_at: new Date().toISOString(),
    session_id: getSessionId(),
    page_url: window.location.href,
    page_path: window.location.pathname,
    page_hash: window.location.hash || "",
    referrer: document.referrer || "",
    viewport: getViewportPayload(),
    section_id: getCurrentSectionId(),
    // Which arm of the homepage waitlist A/B test this session was assigned.
    // Tagging the base payload means every event is comparable by variant,
    // including section_view — so "saw the form" and "signed up" come from one
    // pipeline with one join key (session_id) rather than two.
    waitlist_variant: window.grandWaitlistVariant || "",
    ...details,
  };
  const body = JSON.stringify(payload);

  if (navigator.sendBeacon) {
    const sent = navigator.sendBeacon(analyticsEndpoint, body);
    if (sent) return;
  }

  fetch(analyticsEndpoint, {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    headers: {
      "Content-Type": "text/plain",
    },
    body,
  }).catch(() => {});
}

function getClickTarget(element) {
  if (!(element instanceof Element)) return null;

  const link = element.closest("a");
  const button = element.closest("button");
  const target = link || button;

  if (!target) return null;

  return {
    element_type: target.tagName.toLowerCase(),
    target_text: target.textContent.trim().replace(/\s+/g, " ").slice(0, 120),
    target_href: link?.getAttribute("href") || "",
    target_id: target.id || "",
    target_classes: target.className || "",
    target_label: target.getAttribute("aria-label") || "",
  };
}

function setupClickTracking() {
  document.addEventListener(
    "click",
    (event) => {
      const target = getClickTarget(event.target);
      if (!target) return;

      trackAnalyticsEvent("click", {
        ...target,
        section_id: event.target.closest("section")?.id || getCurrentSectionId(),
      });
    },
    { capture: true },
  );
}

function getStickyHeaderOffset() {
  const header = document.querySelector(".site-header");
  if (!header) return 0;

  return Math.ceil(header.getBoundingClientRect().height) + 12;
}

function getSamePageAnchorTarget(link) {
  const href = link?.getAttribute("href") || "";
  if (!href.startsWith("#") || href === "#") return null;

  return getHashTarget(href);
}

function getHashTarget(hash) {
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return document.getElementById(hash.slice(1));
  }
}

function scrollToAnchorTarget(target, behavior = "smooth") {
  const top = target.getBoundingClientRect().top + window.scrollY - getStickyHeaderOffset();

  window.scrollTo({
    top: Math.max(0, top),
    behavior,
  });
}

function setupAnchorScrolling() {
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const target = getSamePageAnchorTarget(link);
    if (!target) return;

    event.preventDefault();
    const hash = `#${target.id}`;

    try {
      if (window.location.hash !== hash) {
        window.history.pushState(null, "", hash);
      }
    } catch {
      window.location.hash = hash;
    }

    anchorScrollRetries.forEach((delay, index) => {
      window.setTimeout(() => {
        scrollToAnchorTarget(target, index === 0 ? "smooth" : "auto");
      }, delay);
    });

    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  });

  window.addEventListener("load", () => {
    const target = getHashTarget(window.location.hash || "");
    if (!target) return;

    anchorScrollRetries.forEach((delay) => {
      window.setTimeout(() => {
        scrollToAnchorTarget(target, "auto");
      }, delay);
    });
  });
}

function setupSectionViewTracking() {
  if (!("IntersectionObserver" in window)) return;

  const seenSections = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || seenSections.has(entry.target.id)) return;

        seenSections.add(entry.target.id);
        trackAnalyticsEvent("section_view", {
          section_id: entry.target.id,
          section_label:
            entry.target.querySelector("h1, h2")?.textContent.trim().replace(/\s+/g, " ") || "",
        });
      });
    },
    {
      rootMargin: "0px 0px -35% 0px",
      threshold: 0.35,
    },
  );

  trackedSections.forEach((id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

function setWaitlistStatus(message, type = "neutral") {
  const status = document.querySelector("[data-waitlist-status]");
  if (!status) return;

  status.textContent = message;
  status.dataset.status = type;
}

function getUsPhoneDigits(value) {
  const rawDigits = String(value || "").replace(/\D/g, "");
  const digits = rawDigits.length > 10 && rawDigits.startsWith("1")
    ? rawDigits.slice(1)
    : rawDigits;

  return digits.slice(0, 10);
}

function formatUsPhone(digits) {
  const value = getUsPhoneDigits(digits);
  if (!value) return "";
  if (value.length < 4) return `(${value}`;
  if (value.length < 7) return `(${value.slice(0, 3)}) ${value.slice(3)}`;
  return `(${value.slice(0, 3)}) ${value.slice(3, 6)}-${value.slice(6)}`;
}

function getNormalizedPhoneDigitCountBeforeCursor(value, cursorPosition) {
  const allDigits = String(value || "").replace(/\D/g, "");
  const cursorDigits = String(value || "")
    .slice(0, cursorPosition)
    .replace(/\D/g, "");
  const countryPrefixWasTyped = allDigits.length > 10 && allDigits.startsWith("1");
  const digitCount = countryPrefixWasTyped && cursorDigits.length > 0
    ? cursorDigits.length - 1
    : cursorDigits.length;

  return Math.max(0, Math.min(digitCount, 10));
}

function getCaretPositionForPhoneDigitCount(formattedValue, digitCount) {
  if (digitCount <= 0) return formattedValue ? 1 : 0;

  let digitsSeen = 0;
  for (let index = 0; index < formattedValue.length; index += 1) {
    if (/\d/.test(formattedValue[index])) {
      digitsSeen += 1;
      if (digitsSeen === digitCount) return index + 1;
    }
  }

  return formattedValue.length;
}

function formatPhoneInput(input) {
  const cursorPosition = input.selectionStart;
  const digitCountBeforeCursor = typeof cursorPosition === "number"
    ? getNormalizedPhoneDigitCountBeforeCursor(input.value, cursorPosition)
    : null;
  const formattedValue = formatUsPhone(input.value);

  input.value = formattedValue;

  if (
    digitCountBeforeCursor !== null &&
    document.activeElement === input &&
    typeof input.setSelectionRange === "function"
  ) {
    const nextCursorPosition = getCaretPositionForPhoneDigitCount(
      formattedValue,
      digitCountBeforeCursor,
    );
    input.setSelectionRange(nextCursorPosition, nextCursorPosition);
  }
}

function getWaitlistPhoneSubmissionValue(input) {
  return `+1 ${formatUsPhone(input.value)}`;
}

function isValidWaitlistPhone(input) {
  return getUsPhoneDigits(input.value).length === 10;
}

function getValueLengthBucket(value) {
  const length = String(value || "").trim().length;

  if (length === 0) return "0";
  if (length < 6) return "1-5";
  if (length < 12) return "6-11";
  if (length < 24) return "12-23";
  return "24+";
}

function getWaitlistFieldState(input, isEmail) {
  const value = input.value.trim();

  return {
    has_value: value.length > 0,
    looks_valid: isEmail ? value.length > 0 && input.checkValidity() : isValidWaitlistPhone(input),
    value_length_bucket: getValueLengthBucket(value),
  };
}

async function getUserAgentData() {
  const base = getBaseUserAgentData();
  if (!base) return null;
  if (!navigator.userAgentData.getHighEntropyValues) return base;

  try {
    const highEntropy = await navigator.userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
      "model",
      "platformVersion",
      "uaFullVersion",
      "fullVersionList",
      "wow64",
    ]);

    return { ...base, ...highEntropy };
  } catch {
    return base;
  }
}

function getBaseUserAgentData() {
  if (!navigator.userAgentData) return null;

  return {
    brands: navigator.userAgentData.brands,
    mobile: navigator.userAgentData.mobile,
    platform: navigator.userAgentData.platform,
  };
}

async function fetchGeoLocation() {
  try {
    const response = await fetch("https://ipapi.co/json/", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data || data.error) return null;

    return {
      city: data.city || "",
      region: data.region || "",
      country: data.country_name || data.country || "",
      postal: data.postal || "",
      source: "ipapi.co",
    };
  } catch {
    return null;
  }
}

// Report a conversion to the ad pixels. The base pixels load in the page head;
// here we fire the standard conversion events so Meta/Reddit can attribute and
// optimize toward signups (previously only PageView/PageVisit fired). Guarded
// so a blocked or absent pixel never throws.
function firePixelConversion(metaEvent, redditEvent) {
  try {
    if (typeof window.fbq === "function") window.fbq("track", metaEvent);
  } catch {}
  try {
    if (typeof window.rdt === "function") window.rdt("track", redditEvent);
  } catch {}
}

function buildWaitlistPayload(identity, candidateId, variant) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  return {
    type: "waitlist_signup",
    product: PRODUCT,
    // Only the identifier this arm actually asked for. The other column stays
    // blank on the signup row and is filled in later only if the visitor
    // volunteers it on the profile page.
    phone: variant === "email" ? "" : identity,
    email: variant === "email" ? identity : "",
    waitlist_variant: variant,
    candidate_id: candidateId,
    source: "grand-website",
    submitted_at: new Date().toISOString(),
    page_url: window.location.href,
    referrer: document.referrer || "",
    user_agent: navigator.userAgent,
    user_agent_data: cachedUserAgentData || getBaseUserAgentData(),
    language: navigator.language || "",
    languages: navigator.languages || [],
    platform: navigator.platform || "",
    vendor: navigator.vendor || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    timezone_offset_minutes: new Date().getTimezoneOffset(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    screen: {
      width: window.screen?.width || null,
      height: window.screen?.height || null,
      color_depth: window.screen?.colorDepth || null,
      pixel_depth: window.screen?.pixelDepth || null,
    },
    device_pixel_ratio: window.devicePixelRatio || 1,
    hardware_concurrency: navigator.hardwareConcurrency || null,
    device_memory_gb: navigator.deviceMemory || null,
    cookie_enabled: navigator.cookieEnabled,
    do_not_track: navigator.doNotTrack || window.doNotTrack || "",
    connection: connection
      ? {
          effective_type: connection.effectiveType || "",
          downlink: connection.downlink || null,
          rtt: connection.rtt || null,
          save_data: Boolean(connection.saveData),
        }
      : null,
    geo: cachedGeoLocation,
  };
}

function submitWaitlist(endpoint, payload, options = {}) {
  const { waitForCompletion = true } = options;
  const body = JSON.stringify(payload);

  if (!waitForCompletion && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
    if (navigator.sendBeacon(endpoint, blob)) {
      return Promise.resolve();
    }
  }

  const request = fetch(endpoint, {
    method: "POST",
    mode: "no-cors",
    keepalive: !waitForCompletion,
    headers: {
      "Content-Type": "text/plain",
    },
    body,
  });

  return waitForCompletion ? request : request.catch(() => {});
}

if (waitlistForm) {
  // The markup ships one field block per A/B arm. Whichever one this session
  // was not assigned is already hidden by the stylesheet, so remove it from the
  // DOM outright: a hidden `required` input would otherwise stay behind as an
  // autofill and screen-reader target. No reflow, because it already occupies
  // no space. Defaults to phone when ab-test.js is blocked or absent, matching
  // the stylesheet's fallback.
  // Whether ab-test.js actually ran and assigned an arm. When it did not — the
  // script was dropped by a flaky connection, failed to parse on an old engine,
  // or the visitor is a bot running a stripped JS engine — `activeVariant`
  // below silently falls back to phone. That fallback is intentional (degrade
  // to the form that was live before this test), but it is invisible, and an
  // invisible fallback is indistinguishable from a real assignment when you are
  // staring at a lopsided split wondering whether the randomizer is broken.
  const variantWasAssigned =
    window.grandWaitlistVariant === "phone" || window.grandWaitlistVariant === "email";
  const activeVariant = window.grandWaitlistVariant === "email" ? "email" : "phone";
  waitlistForm
    .querySelectorAll(`[data-waitlist-field]:not([data-waitlist-field="${activeVariant}"])`)
    .forEach((field) => field.remove());

  const input = waitlistForm.querySelector("input[type='tel'], input[type='email']");
  const button = waitlistForm.querySelector("button[type='submit']");
  const isEmailVariant = input?.type === "email";
  let trackedFieldInputStart = false;

  // The test's exposure event, and the funnel's denominator. Fired here rather
  // than in ab-test.js because grandTrackWebsiteEvent does not exist yet when
  // that synchronous head script runs. Deliberately PostHog-only: the sheet
  // pipeline already gets a variant-tagged section_view for #waitlist, and an
  // extra beacon per homepage view would add an Apps Script execution per
  // visitor for data we already have.
  //
  // Fired at most ONCE PER SESSION. The variant is sticky for the whole
  // session, so a visitor who reloads the homepage — or navigates back to it
  // from welcome.html — would otherwise log an exposure per page load, every
  // one of them in the same arm. That does not just inflate the count, it
  // biases the ratio: a handful of reloads by a few visitors is enough to make
  // an even 50/50 assignment read as lopsided, which is exactly what it did
  // (15 PostHog exposures against 9 real sessions, splitting 11/4 while the
  // sheet showed 12/12 for the day).
  //
  // `variant_assigned: false` marks a visitor who was never randomized. These
  // are already excluded from the experiment itself, because posthog.js only
  // sets the `$feature/...` property when a real arm was assigned — so they
  // cannot skew the split. What they do skew is the denominator: they are
  // traffic the experiment never saw. Tagging them turns "how often does this
  // happen?" into a number you can read off a breakdown instead of a question
  // that has to be re-argued every time the split looks uneven.
  if (!hasLoggedVariantExposure()) {
    window.grandTrackWebsiteEvent?.("waitlist_variant_assigned", {
      waitlist_variant: activeVariant,
      variant_assigned: variantWasAssigned,
    });
  }

  function isValidWaitlistValue() {
    if (!input) return false;

    return isEmailVariant
      ? input.value.trim().length > 0 && input.checkValidity()
      : isValidWaitlistPhone(input);
  }

  function syncWaitlistFieldState(options = {}) {
    if (!input || !button) return;

    const hasValue = isEmailVariant
      ? input.value.trim().length > 0
      : getUsPhoneDigits(input.value).length > 0;
    const isValid = isValidWaitlistValue();
    const showError = Boolean(options.showError && hasValue && !isValid);

    button.disabled = !isValid;
    input.setAttribute("aria-invalid", showError ? "true" : "false");

    if (showError) {
      setWaitlistStatus(
        isEmailVariant ? "Enter a valid email address." : "Enter a 10-digit US phone number.",
        "error",
      );
    } else if (!options.preserveStatus) {
      setWaitlistStatus("", "neutral");
    }
  }

  if (input && button) {
    syncWaitlistFieldState();

    input.addEventListener(
      "focus",
      () => {
        trackAnalyticsEvent(`waitlist_${activeVariant}_focus`, {
          section_id: "waitlist",
        });
        window.grandTrackWebsiteEvent?.("waitlist_started", {
          form_type: activeVariant,
        });
      },
      { once: true },
    );

    input.addEventListener("input", () => {
      if (!isEmailVariant) formatPhoneInput(input);
      syncWaitlistFieldState();

      if (trackedFieldInputStart || input.value.trim().length === 0) return;

      trackedFieldInputStart = true;
      trackAnalyticsEvent(`waitlist_${activeVariant}_input_start`, {
        section_id: "waitlist",
        ...getWaitlistFieldState(input, isEmailVariant),
      });
    });

    input.addEventListener("blur", () => {
      if (!isEmailVariant) formatPhoneInput(input);
      syncWaitlistFieldState({ showError: true });

      trackAnalyticsEvent(`waitlist_${activeVariant}_blur`, {
        section_id: "waitlist",
        ...getWaitlistFieldState(input, isEmailVariant),
      });
    });
  }

  waitlistForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const endpoint = waitlistForm.dataset.waitlistEndpoint?.trim();
    if (!input || !button) return;

    trackAnalyticsEvent("waitlist_submit_attempt", {
      section_id: "waitlist",
    });

    if (!isEmailVariant) formatPhoneInput(input);
    const identity = isEmailVariant
      ? input.value.trim()
      : getWaitlistPhoneSubmissionValue(input);

    if (!isValidWaitlistValue()) {
      const failureReason = isEmailVariant ? "invalid_email" : "invalid_phone";
      trackAnalyticsEvent("waitlist_submit_error", {
        section_id: "waitlist",
        error: failureReason,
      });
      window.grandTrackWebsiteEvent?.("waitlist_submission_failed", {
        failure_reason: failureReason,
      });
      syncWaitlistFieldState({ showError: true });
      input.focus();
      return;
    }

    if (!endpoint) {
      trackAnalyticsEvent("waitlist_submit_error", {
        section_id: "waitlist",
        error: "missing_endpoint",
      });
      window.grandTrackWebsiteEvent?.("waitlist_submission_failed", {
        failure_reason: "missing_endpoint",
      });
      setWaitlistStatus("The waitlist sheet is not connected yet.", "error");
      return;
    }

    const originalLabel = button.textContent;
    waitlistForm.dataset.submitting = "true";
    button.disabled = true;
    button.textContent = "Joining...";
    setWaitlistStatus("", "neutral");
    let submitted = false;

    try {
      const candidateId = window.grandGetOrCreateWebsiteCandidateId?.() || "";
      window.grandIdentifyWebsiteCandidate?.(candidateId);
      const payload = buildWaitlistPayload(identity, candidateId, activeVariant);
      void submitWaitlist(endpoint, payload, { waitForCompletion: false });
      waitlistForm.reset();
      submitted = true;
      trackAnalyticsEvent("waitlist_submit_success", {
        section_id: "waitlist",
      });
      window.grandTrackWebsiteEvent?.("waitlist_signup", {
        form_type: activeVariant,
      });
      firePixelConversion("Lead", "SignUp");
      setWaitlistStatus("You're on the list. Taking you to a couple of quick questions...", "success");

      // Progressive profiling: hand off to the profile page to collect
      // qualifying details, without ever gating the identifier behind them.
      // The value travels via sessionStorage (not the URL) so it isn't leaked
      // into the profile page's referrer/pixel traffic. The success message
      // above stays visible if navigation is blocked.
      try {
        window.sessionStorage.setItem(
          isEmailVariant ? "grand_signup_email" : "grand_signup_phone",
          identity,
        );
        // Clear the opposite key. welcome.html decides what to ask for from
        // which of these two exists, so leaving a stale value from an earlier
        // ?variant= switch in the same session would make it conclude we
        // already have both and offer neither.
        window.sessionStorage.removeItem(
          isEmailVariant ? "grand_signup_phone" : "grand_signup_email",
        );
      } catch {}
      window.location.assign("welcome.html");
    } catch (error) {
      console.warn(error);
      trackAnalyticsEvent("waitlist_submit_error", {
        section_id: "waitlist",
        error: "network_or_script_error",
      });
      window.grandTrackWebsiteEvent?.("waitlist_submission_failed", {
        failure_reason: "network_or_script_error",
      });
      setWaitlistStatus("Something went wrong. Please try again.", "error");
    } finally {
      delete waitlistForm.dataset.submitting;
      button.textContent = originalLabel;
      if (!submitted) syncWaitlistFieldState({ preserveStatus: true });
    }
  });
}

function setProfileStatus(message, type = "neutral") {
  const status = document.querySelector("[data-profile-status]");
  if (!status) return;

  status.textContent = message;
  status.dataset.status = type;
}

function buildProfilePayload(form) {
  let storedPhone = "";
  let storedEmail = "";
  let candidateId = "";
  try {
    storedPhone = window.sessionStorage.getItem("grand_signup_phone") || "";
    storedEmail = window.sessionStorage.getItem("grand_signup_email") || "";
    candidateId = window.sessionStorage.getItem("grand_website_candidate_id") || "";
  } catch {}

  const data = new FormData(form);
  const phoneInput = form.querySelector("input[type='tel']");
  // The optional second contact method, normalized the same way the homepage
  // does it so the two arms write identically formatted values. Sent only when
  // non-empty: the backend writes contact columns only for non-empty values, so
  // a blank field can never clear what the signup already captured.
  const submittedPhone =
    phoneInput && getUsPhoneDigits(phoneInput.value).length > 0
      ? getWaitlistPhoneSubmissionValue(phoneInput)
      : "";

  return {
    type: "waitlist_profile",
    product: PRODUCT,
    // Whichever identifier the signup captured is the identity used to find
    // this person's row; the other one, if given here, is extra contact data.
    phone: storedPhone || submittedPhone,
    email: storedEmail || String(data.get("email") || "").trim(),
    // Lets the backend match the signup row on the column that arm actually
    // wrote, instead of guessing phone-then-email and appending a duplicate.
    waitlist_variant: window.grandWaitlistVariant || "",
    candidate_id: candidateId,
    source: "grand-website",
    full_name: String(data.get("full_name") || "").trim(),
    zipcode: String(data.get("zipcode") || "").trim(),
    reason_interested: String(data.get("reason_interested") || "").trim(),
    lives_alone: String(data.get("lives_alone") || ""),
    phone_type: String(data.get("phone_type") || ""),
    has_pets: String(data.get("has_pets") || ""),
    alpha_tester: String(data.get("alpha_tester") || ""),
    profile_completed_at: new Date().toISOString(),
    page_url: window.location.href,
    referrer: document.referrer || "",
  };
}

if (profileForm) {
  const doneMessage = document.querySelector("[data-profile-done]");
  const waitlistedMessage = document.querySelector("[data-profile-waitlisted]");

  // Ask only for the contact method the signup did not capture. The unused
  // field is already hidden by the stylesheet; removing it stops autofill
  // quietly populating a value the visitor never saw themselves give us.
  // "both" (a direct visit, or a session with nothing stored) leaves both.
  const profileAsk = window.grandProfileAsk || "both";
  if (profileAsk === "email" || profileAsk === "phone") {
    profileForm
      .querySelectorAll(`[data-profile-field]:not([data-profile-field="${profileAsk}"])`)
      .forEach((field) => field.remove());
  }

  // Same live formatting as the homepage phone field, so an optional phone
  // given here behaves and normalizes identically.
  const profilePhoneInput = profileForm.querySelector("input[type='tel']");
  if (profilePhoneInput) {
    ["input", "blur"].forEach((eventName) => {
      profilePhoneInput.addEventListener(eventName, () => formatPhoneInput(profilePhoneInput));
    });
  }

  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const button = profileForm.querySelector("button[type='submit']");
    const endpoint = profileForm.dataset.waitlistEndpoint?.trim();
    if (!button) return;

    trackAnalyticsEvent("waitlist_profile_submit_attempt", {
      section_id: "welcome",
    });

    // The qualifier answers decide who is routed to the scheduling call vs. the
    // waitlist, and name/ZIP are how we follow up, so those stay required.
    // The contact field is not required: the signup already captured one way to
    // reach this person, and the second one is a nice-to-have we would rather
    // not push anyone away over. Keeping it optional in both arms also keeps
    // them symmetric, so the test measures the field type and nothing else.
    const answers = new FormData(profileForm);
    const requiredFields = [
      "full_name",
      "zipcode",
      "phone_type",
      "lives_alone",
      "has_pets",
    ];
    const firstMissing = requiredFields.find(
      (name) => !String(answers.get(name) || "").trim()
    );
    if (firstMissing) {
      trackAnalyticsEvent("waitlist_profile_submit_error", {
        section_id: "welcome",
        error: "missing_required_field",
      });
      setProfileStatus("Please complete all required fields.", "error");
      profileForm
        .querySelector(`[name="${firstMissing}"]`)
        ?.focus();
      return;
    }

    // The form is novalidate (JS drives the flow), so check the optional
    // contact fields ourselves — but only once something has been typed into
    // them. Leaving either blank has to submit cleanly.
    const emailField = profileForm.querySelector("#email");
    if (emailField && emailField.value.trim() && !emailField.checkValidity()) {
      trackAnalyticsEvent("waitlist_profile_submit_error", {
        section_id: "welcome",
        error: "invalid_email",
      });
      setProfileStatus("Please enter a valid email address, or leave it blank.", "error");
      emailField.focus();
      return;
    }

    const phoneField = profileForm.querySelector("input[type='tel']");
    if (phoneField && phoneField.value.trim() && !isValidWaitlistPhone(phoneField)) {
      trackAnalyticsEvent("waitlist_profile_submit_error", {
        section_id: "welcome",
        error: "invalid_phone",
      });
      setProfileStatus("Please enter a 10-digit US phone number, or leave it blank.", "error");
      phoneField.focus();
      return;
    }

    if (!endpoint) {
      trackAnalyticsEvent("waitlist_profile_submit_error", {
        section_id: "welcome",
        error: "missing_endpoint",
      });
      window.grandTrackWebsiteEvent?.("profile_submission_failed", {
        failure_reason: "missing_endpoint",
      });
      setProfileStatus("This form is not connected yet.", "error");
      return;
    }

    const payload = buildProfilePayload(profileForm);
    // Fire-and-forget, like the initial signup capture: sendBeacon (with a
    // keepalive fetch fallback) so the confirmation shows instantly instead of
    // blocking on the Apps Script round trip — that call holds a script lock and
    // runs a signup-row retry loop that can take ~1.4s. The backend appends a
    // fallback row if the match is missed, so optional profile answers are never
    // lost.
    void submitWaitlist(endpoint, payload, { waitForCompletion: false });
    firePixelConversion("CompleteRegistration", "Lead");

    // Only good-fit alpha candidates see the scheduling link: an iPhone-using
    // caregiver whose loved one lives alone and has no pets. Everyone else still
    // has their answers saved but lands on the "you're on the list" panel.
    const qualifies =
      payload.phone_type === "iphone" &&
      payload.lives_alone === "yes" &&
      payload.has_pets === "no";

    trackAnalyticsEvent("waitlist_profile_submit_success", {
      section_id: "welcome",
      qualified: qualifies,
    });
    window.grandTrackWebsiteEvent?.("profile_completed", { qualified: qualifies });

    const panel = qualifies ? doneMessage : waitlistedMessage;
    if (panel) {
      (profileForm.closest("[data-profile-layout]") || profileForm).hidden = true;
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      setProfileStatus("Thank you — we've got everything we need.", "success");
    }
  });
}

setupClickTracking();
setupAnchorScrolling();
setupSectionViewTracking();
