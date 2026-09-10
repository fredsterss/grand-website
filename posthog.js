(function setupGrandWebsiteAnalytics(window, document) {
  "use strict";

  const POSTHOG_PROJECT_TOKEN = "phc_pcunHwXxRJ2QgbwTzYuExEm8toDhHboXmfEnzK38A8qd";
  const POSTHOG_API_HOST = "https://us.i.posthog.com";
  const POSTHOG_ASSET_URL = "https://us-assets.i.posthog.com/static/1/array.js";
  const WAITLIST_EXPERIMENT_FLAG_KEY = "homepage-waitlist-contact-field";
  const CANDIDATE_ID_STORAGE_KEY = "grand_website_candidate_id";
  const queuedEvents = [];
  let posthogReady = false;
  let pendingCandidateId = "";

  function isCandidateId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || ""),
    );
  }

  function getStoredCandidateId() {
    try {
      const candidateId = window.sessionStorage.getItem(CANDIDATE_ID_STORAGE_KEY) || "";
      return isCandidateId(candidateId) ? candidateId : "";
    } catch {
      return "";
    }
  }

  function createCandidateId() {
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    if (typeof window.crypto?.getRandomValues !== "function") return "";

    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function getOrCreateCandidateId() {
    try {
      const storedCandidateId = getStoredCandidateId();
      if (storedCandidateId) return storedCandidateId;

      const candidateId = createCandidateId();
      if (!candidateId) return "";

      try {
        window.sessionStorage.setItem(CANDIDATE_ID_STORAGE_KEY, candidateId);
      } catch {}
      return candidateId;
    } catch {
      return "";
    }
  }

  function getWebsiteContext() {
    const path = window.location.pathname;
    const isGrace = path === "/grace" || path.startsWith("/grace/");
    let pageType = "landing";

    if (path.endsWith("/welcome.html") || path === "/welcome.html") {
      pageType = "onboarding";
    } else if (path.endsWith("/privacy.html") || path.endsWith("/terms.html")) {
      pageType = "legal";
    }

    const context = {
      platform: "web",
      analytics_surface: "marketing_website",
      website_experience: isGrace ? "grace" : "grand",
      website_page_type: pageType,
    };

    // Which arm of the Grand homepage waitlist A/B test this session is in, as
    // assigned by ab-test.js. Added here rather than through a register() call
    // so one insertion point covers the registered super properties, every
    // website_* event, and $pageview. Guarded on the two known values because
    // Grace shares this file and has no ab-test.js — its payloads stay
    // byte-identical.
    if (window.grandWaitlistVariant === "phone" || window.grandWaitlistVariant === "email") {
      context.waitlist_variant = window.grandWaitlistVariant;
      // PostHog's experiment analysis expects externally assigned variants on
      // a $feature/<flag-key> property. Keep the local, synchronous assignment
      // as the source of truth so loading analytics can never delay or flash
      // the waitlist field. PostHog reserves "control" for the first variant.
      context[`$feature/${WAITLIST_EXPERIMENT_FLAG_KEY}`] =
        window.grandWaitlistVariant === "phone" ? "control" : "test";
    }

    return context;
  }

  function safelyCapture(posthog, eventName, properties) {
    try {
      posthog.capture(eventName, properties);
    } catch {}
  }

  function captureWebsiteEvent(eventName, properties) {
    if (!eventName) return;

    const event = {
      name: `website_${eventName}`,
      properties: {
        ...getWebsiteContext(),
        ...(properties || {}),
      },
    };

    if (!posthogReady || typeof window.posthog?.capture !== "function") {
      queuedEvents.push(event);
      return;
    }

    safelyCapture(window.posthog, event.name, event.properties);
  }

  function identifyWebsiteCandidate(candidateId) {
    if (!isCandidateId(candidateId)) return;

    pendingCandidateId = candidateId;
    if (!posthogReady || typeof window.posthog?.identify !== "function") return;

    const websiteContext = getWebsiteContext();
    try {
      window.posthog.identify(candidateId, {
        candidate_id: candidateId,
        platform: websiteContext.platform,
        analytics_surface: websiteContext.analytics_surface,
        website_experience: websiteContext.website_experience,
      });
    } catch {}
  }

  // Page-specific scripts use this narrow wrapper instead of accessing the
  // PostHog SDK directly. The only identity accepted is a random UUID; no form
  // values or other personal data are accepted.
  window.grandTrackWebsiteEvent = captureWebsiteEvent;
  window.grandGetOrCreateWebsiteCandidateId = getOrCreateCandidateId;
  window.grandIdentifyWebsiteCandidate = identifyWebsiteCandidate;

  function getClickLocation(link) {
    return (
      link.closest("section")?.id ||
      (link.closest("header") ? "header" : "") ||
      (link.closest("footer") ? "footer" : "") ||
      "page"
    );
  }

  document.addEventListener(
    "click",
    function trackMeaningfulWebsiteClick(event) {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link) return;

      const href = link.getAttribute("href") || "";
      const label = (link.getAttribute("aria-label") || link.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
      const properties = {
        cta_label: label,
        cta_location: getClickLocation(link),
      };

      if (href.includes("calendly.com")) {
        captureWebsiteEvent("onboarding_call_clicked", properties);
      } else if (href.startsWith("mailto:")) {
        captureWebsiteEvent("contact_clicked", {
          ...properties,
          contact_method: "email",
        });
      } else if (link.classList.contains("button") || link.classList.contains("nav-cta")) {
        captureWebsiteEvent("cta_clicked", {
          ...properties,
          cta_target: href.startsWith("#") ? href : "other_page",
        });
      }
    },
    { capture: true },
  );

  function initializePostHog() {
    if (typeof window.posthog?.init !== "function") return;

    const websiteContext = getWebsiteContext();
    window.posthog.init(POSTHOG_PROJECT_TOKEN, {
      api_host: POSTHOG_API_HOST,
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      cookieless_mode: "always",
      person_profiles: "identified_only",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      capture_performance: {
        web_vitals: true,
      },
      capture_exceptions: false,
      disable_session_recording: true,
      advanced_disable_flags: true,
      loaded: function onPostHogLoaded(posthog) {
        posthogReady = true;
        const candidateId = pendingCandidateId || getStoredCandidateId();
        if (candidateId) identifyWebsiteCandidate(candidateId);
        try {
          posthog.register(websiteContext);
        } catch {}
        safelyCapture(posthog, "$pageview", websiteContext);

        queuedEvents.splice(0).forEach(function flushQueuedEvent(event) {
          safelyCapture(posthog, event.name, event.properties);
        });
      },
    });
  }

  const sdkScript = document.createElement("script");
  sdkScript.async = true;
  sdkScript.src = POSTHOG_ASSET_URL;
  sdkScript.onload = initializePostHog;
  document.head.appendChild(sdkScript);
})(window, document);
