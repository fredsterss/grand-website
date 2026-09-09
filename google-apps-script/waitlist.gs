// Optional but recommended: paste the ID from the Google Sheet URL here.
// Example: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
const SPREADSHEET_ID = "1i2_lUmRSIVA1iN3zaE8mLrR-8QEpOUPKtM8Y6aHfw1w";
const SHEET_NAME = "Waitlist";
const EVENT_SHEET_NAME = "Events";

// Bumped whenever this file changes in a way the site depends on, and returned
// by doGet. Saving code in the Apps Script editor does not update the live web
// app (that needs Deploy -> Manage deployments -> New version), and until now
// there was no way to tell the deployed version apart from the committed one.
const CODE_VERSION = "2026-09-09-ab-variant-2";

// Separate product lines (gracecompanion, gracephone) share this one endpoint
// and spreadsheet but land in their own tabs, so their signups/events never mix
// with Grand's. Payloads carry a `product` field; anything without a known
// product (i.e. the Grand site) falls through to the default tabs above, so
// Grand's behavior is completely unchanged.
const PRODUCT_SHEETS = {
  gracecompanion: { waitlist: "GraceCompanion Waitlist", events: "GraceCompanion Events" },
  gracephone: { waitlist: "GracePhone Waitlist", events: "GracePhone Events" },
  // Grand's alpha signup collects a phone number instead of an email. It lands
  // in its own tabs so the email-era "Waitlist"/"Events" tabs freeze as an
  // archive and the phone column never mixes with the historical email column.
  grandphone: { waitlist: "Grand phone number alpha list", events: "Grand phone number events" },
};

function sheetNamesForProduct_(product) {
  const key = String(product || "").trim().toLowerCase();
  return PRODUCT_SHEETS[key] || { waitlist: SHEET_NAME, events: EVENT_SHEET_NAME };
}

const HEADERS = [
  "received_at",
  "email",
  "source",
  "submitted_at",
  "page_url",
  "referrer",
  "user_agent",
  "user_agent_data",
  "language",
  "languages",
  "platform",
  "vendor",
  "timezone",
  "timezone_offset_minutes",
  "viewport_width",
  "viewport_height",
  "screen_width",
  "screen_height",
  "screen_color_depth",
  "screen_pixel_depth",
  "device_pixel_ratio",
  "hardware_concurrency",
  "device_memory_gb",
  "cookie_enabled",
  "do_not_track",
  "connection_effective_type",
  "connection_downlink",
  "connection_rtt",
  "connection_save_data",
  "raw_payload",
  // Captured passively at signup via client-side IP geolocation.
  "geo_city",
  "geo_region",
  "geo_country",
  "geo_postal",
  // Collected on the post-signup profile page (welcome.html); blank until the
  // person completes it, then filled in on the same row by email.
  "zipcode",
  "reason_interested",
  "lives_alone",
  "alpha_tester",
  "profile_completed_at",
  "full_name",
  // Phone-based products (Grand phone alpha list) identify people by phone
  // instead of email. Appended last so existing email sheets auto-migrate with
  // a blank column and no existing column shifts.
  "phone",
  // Random, non-personal UUID shared with the sign-up's PostHog person profile.
  // Appended last so existing sheets migrate without shifting any columns.
  "candidate_id",
  // Qualifier answers collected on the profile page (welcome.html); used to
  // decide who sees the scheduling call link. Appended last so existing sheets
  // migrate without shifting any columns.
  "phone_type",
  "has_pets",
  // Which homepage waitlist field this person was shown: "phone" or "email".
  // Appended last so existing sheets migrate without shifting any columns.
  "waitlist_variant",
];

const EVENT_HEADERS = [
  "received_at",
  "event_at",
  "event_type",
  "session_id",
  "page_url",
  "page_path",
  "page_hash",
  "referrer",
  "section_id",
  "section_label",
  "element_type",
  "target_text",
  "target_href",
  "target_id",
  "target_classes",
  "target_label",
  "viewport_width",
  "viewport_height",
  "error",
  "raw_payload",
  "has_value",
  "looks_valid",
  "value_length_bucket",
  "waitlist_variant",
];

function doGet() {
  const spreadsheet = getSpreadsheet_();

  // Report every product's tabs, not just the default pair. The default
  // SHEET_NAME/EVENT_SHEET_NAME tabs are the frozen email-era archive, so a
  // health check that reported only those could not tell you whether live Grand
  // signups (which route to the grandphone tabs) were landing at all — it just
  // showed a stagnant row count. Uses getSheetByName rather than getSheet_ so a
  // health check can never create an empty tab as a side effect.
  const products = Object.assign(
    { default: { waitlist: SHEET_NAME, events: EVENT_SHEET_NAME } },
    PRODUCT_SHEETS,
  );
  const sheets = {};

  Object.keys(products).forEach((product) => {
    const waitlistSheet = spreadsheet.getSheetByName(products[product].waitlist);
    const eventSheet = spreadsheet.getSheetByName(products[product].events);

    sheets[product] = {
      waitlist_sheet_name: products[product].waitlist,
      waitlist_last_row: waitlistSheet ? waitlistSheet.getLastRow() : null,
      event_sheet_name: products[product].events,
      event_last_row: eventSheet ? eventSheet.getLastRow() : null,
    };
  });

  return jsonResponse_({
    ok: true,
    service: "Grand website backend",
    code_version: CODE_VERSION,
    spreadsheet_url: spreadsheet.getUrl(),
    sheets,
  });
}

function doPost(event) {
  try {
    const payload = JSON.parse(event?.postData?.contents || "{}");

    if (payload.type === "analytics_event") {
      return handleAnalyticsEvent_(payload);
    }

    if (payload.type === "waitlist_profile") {
      return handleWaitlistProfile_(payload);
    }

    return handleWaitlistSignup_(payload);
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

function handleWaitlistSignup_(payload) {
  const email = String(payload.email || "").trim().toLowerCase();
  const phone = String(payload.phone || "").trim();

  // Phone-based signups (Grand phone alpha list) identify by phone number and
  // carry no email. Everything else keeps the existing email contract.
  if (phone) {
    if (!isValidPhone_(phone)) {
      return jsonResponse_({ ok: false, error: "invalid_phone" });
    }
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse_({ ok: false, error: "invalid_email" });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  let result;
  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = getSheet_(spreadsheet, sheetNamesForProduct_(payload.product).waitlist);
    ensureHeaders_(sheet, HEADERS);
    ensurePhoneColumnIsText_(sheet);
    sheet.appendRow(rowForPayload_(email, payload));
    result = {
      ok: true,
      spreadsheet_url: sheet.getParent().getUrl(),
      sheet_name: sheet.getName(),
      row: sheet.getLastRow(),
    };
  } finally {
    lock.releaseLock();
  }

  return jsonResponse_(result);
}

function handleWaitlistProfile_(payload) {
  const email = String(payload.email || "").trim().toLowerCase();
  const phone = String(payload.phone || "").trim();

  const profileValues = {
    full_name: String(payload.full_name || "").trim(),
    zipcode: String(payload.zipcode || "").trim(),
    reason_interested: String(payload.reason_interested || "").trim(),
    lives_alone: String(payload.lives_alone || "").trim(),
    phone_type: String(payload.phone_type || "").trim(),
    has_pets: String(payload.has_pets || "").trim(),
    alpha_tester: String(payload.alpha_tester || "").trim(),
    profile_completed_at: payload.profile_completed_at || new Date().toISOString(),
  };

  const candidateId = candidateId_(payload.candidate_id);
  if (candidateId) profileValues.candidate_id = candidateId;

  // The optional second contact method captured on the profile page: the phone
  // arm is offered an email here, the email arm a phone. Neither is required,
  // so only write a value when one was actually given — an empty submission
  // must never clear a value already on the row.
  if (email) profileValues.email = email;
  // Apostrophe-prefixed via plainTextPhone_ because writeProfileColumns_ uses
  // setValue, which applies user-entry parsing: a raw "+1 (555) 123-4567" would
  // be read as a formula and land as #ERROR!. Previously phone was only ever
  // written to the standalone fallback row, never to a matched one, so a phone
  // given on the profile page would have been dropped.
  if (phone) profileValues.phone = plainTextPhone_(phone);

  const variant = variant_(payload.waitlist_variant);
  if (variant) profileValues.waitlist_variant = variant;

  const spreadsheet = getSpreadsheet_();
  const sheet = getSheet_(spreadsheet, sheetNamesForProduct_(payload.product).waitlist);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  let result;
  try {
    ensureHeaders_(sheet, HEADERS);
  } finally {
    lock.releaseLock();
  }

  // The signup is submitted with sendBeacon/keepalive so visitors can leave the
  // page immediately. If the profile form is submitted right away, give the
  // signup append a short chance to land before appending a fallback
  // profile-only row.
  const identities = signupIdentities_(candidateId, variant, phone, email);
  const rowIndex = waitForSignupRow_(sheet, identities);

  lock.waitLock(10000);
  try {
    ensureHeaders_(sheet, HEADERS);
    ensurePhoneColumnIsText_(sheet);

    const latestRowIndex = findSignupRow_(sheet, identities);
    const targetRowIndex = latestRowIndex > 0 ? latestRowIndex : rowIndex;

    if (targetRowIndex > 0) {
      // Update the existing signup row in place — one row per person.
      writeProfileColumns_(sheet, targetRowIndex, profileValues);
      result = { ok: true, matched: true, updated_row: targetRowIndex };
    } else {
      // No matching signup (identifier missing or unknown) — append a
      // standalone row so the answers aren't lost.
      const row = new Array(HEADERS.length).fill("");
      row[HEADERS.indexOf("received_at")] = new Date();
      row[HEADERS.indexOf("email")] = email;
      row[HEADERS.indexOf("phone")] = plainTextPhone_(phone);
      row[HEADERS.indexOf("candidate_id")] = candidateId;
      row[HEADERS.indexOf("source")] = payload.source || "";
      row[HEADERS.indexOf("raw_payload")] = JSON.stringify(payload);
      applyProfileToRow_(row, profileValues);
      sheet.appendRow(row);
      result = { ok: true, matched: false, appended_row: sheet.getLastRow() };
    }
  } finally {
    lock.releaseLock();
  }

  return jsonResponse_(result);
}

function handleAnalyticsEvent_(payload) {
  const eventType = String(payload.event_type || "").trim();

  if (!eventType) {
    return jsonResponse_({ ok: false, error: "missing_event_type" });
  }

  const spreadsheet = getSpreadsheet_();
  const sheet = getSheet_(spreadsheet, sheetNamesForProduct_(payload.product).events);
  ensureHeaders_(sheet, EVENT_HEADERS);
  sheet.appendRow(rowForEventPayload_(payload));

  return jsonResponse_({
    ok: true,
    spreadsheet_url: sheet.getParent().getUrl(),
    sheet_name: sheet.getName(),
    row: sheet.getLastRow(),
  });
}

function getSpreadsheet_() {
  const spreadsheet = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error("No spreadsheet found. Bind this script to a Google Sheet or set SPREADSHEET_ID.");
  }

  return spreadsheet;
}

function getSheet_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function ensureHeaders_(sheet, headers) {
  // Empty sheet: write the header row and freeze it.
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }

  // Existing sheet: if columns were appended to `headers`, extend the header
  // row in place so the live sheet auto-migrates without a manual step. Safe
  // because we only ever append columns to the end — no existing column moves,
  // so overwriting row 1 rewrites the same labels plus the new ones.
  //
  // Make sure the grid is physically wide enough first. A sheet whose column
  // count still matches the old HEADERS length has no cell to write the new
  // label into, and getRange past the grid edge throws.
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns < headers.length) {
    sheet.insertColumnsAfter(maxColumns, headers.length - maxColumns);
  }

  // Compare the header row's actual contents rather than sheet.getLastColumn().
  // getLastColumn() reports the last column holding content ANYWHERE in the
  // sheet, not the width of the header row — so a single stray value out to the
  // right of the data (a hand-added notes column, a paste that overshot) makes
  // it >= headers.length and this migration is silently skipped. New values
  // still get written into their column, but with a blank header above them,
  // which looks exactly like "the column never appeared".
  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const headersAreStale = headers.some(function isMismatched(header, index) {
    return String(currentHeaders[index] || "").trim() !== header;
  });

  if (headersAreStale) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

// Normalize an identity value for matching: phone numbers compare on digits
// only (so "(555) 123-4567" and "5551234567" match), emails on lowercased text.
function normalizeIdentity_(header, value) {
  const text = String(value || "").trim();
  return header === "phone" ? text.replace(/\D/g, "") : text.toLowerCase();
}

function isValidPhone_(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function candidateId_(value) {
  const candidateId = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    candidateId,
  )
    ? candidateId
    : "";
}

// Allowlist the A/B variant tag. It comes from the client and lands in a sheet
// cell, so only the two known values are ever written through.
function variant_(value) {
  const variant = String(value || "").trim().toLowerCase();
  return variant === "phone" || variant === "email" ? variant : "";
}

function plainTextPhone_(value) {
  const phone = String(value || "").trim();
  return phone ? `'${phone}` : "";
}

// Force the phone column to plain-text (`@`) number format. Google Sheets
// parses any cell starting with `+`, `=`, `-`, or `@` as a formula, so a raw
// phone like "+1 (555) 123-4567" would evaluate to #ERROR!. Belt-and-suspenders
// alongside plainTextPhone_'s leading apostrophe: even if a value ever reaches a
// cell without the apostrophe, the text format keeps it from being parsed.
function ensurePhoneColumnIsText_(sheet) {
  const column = HEADERS.indexOf("phone") + 1;
  if (column <= 0) return;
  const rows = Math.max(sheet.getMaxRows(), 1);
  sheet.getRange(1, column, rows, 1).setNumberFormat("@");
}

function findRowByColumn_(sheet, header, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const column = HEADERS.indexOf(header) + 1;
  if (column <= 0) return -1;

  const target = normalizeIdentity_(header, value);
  if (!target) return -1;

  const values = sheet.getRange(2, column, lastRow - 1, 1).getValues();

  // Search from the bottom so the most recent signup wins on duplicates.
  for (let i = values.length - 1; i >= 0; i--) {
    if (normalizeIdentity_(header, values[i][0]) === target) {
      return i + 2;
    }
  }

  return -1;
}

// Ordered [column, value] pairs to try when matching a profile submission back
// to its signup row, most reliable first.
function signupIdentities_(candidateId, variant, phone, email) {
  const identities = [];
  const seen = {};

  function add(column, value) {
    const key = `${column}:${normalizeIdentity_(column, value)}`;
    if (!value || seen[key]) return;
    seen[key] = true;
    identities.push([column, value]);
  }

  // candidate_id first: a random UUID that both the signup and the profile
  // payload carry verbatim, so it does not depend on which field the A/B
  // variant happened to ask for.
  add("candidate_id", candidateId);

  // Then the column the signup row was actually created with. This is what the
  // variant tag is for: in the email arm the signup wrote only an email, so
  // matching on phone would always miss — the row's phone column is blank while
  // this profile payload may well carry a phone, and the miss would append a
  // duplicate row for every single email-arm profile submission.
  if (variant === "email") add("email", email);
  if (variant === "phone") add("phone", phone);

  // Finally anything else we hold, so untagged submissions from older sessions
  // keep matching exactly as they did before.
  add("phone", phone);
  add("email", email);

  return identities;
}

function findSignupRow_(sheet, identities) {
  for (let i = 0; i < identities.length; i++) {
    const rowIndex = findRowByColumn_(sheet, identities[i][0], identities[i][1]);
    if (rowIndex > 0) return rowIndex;
  }

  return -1;
}

function waitForSignupRow_(sheet, identities) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rowIndex = findSignupRow_(sheet, identities);
    if (rowIndex > 0) return rowIndex;
    Utilities.sleep(350);
  }

  return -1;
}

function writeProfileColumns_(sheet, rowIndex, profileValues) {
  Object.keys(profileValues).forEach((header) => {
    const column = HEADERS.indexOf(header) + 1;
    if (column > 0) {
      sheet.getRange(rowIndex, column).setValue(profileValues[header]);
    }
  });
}

function applyProfileToRow_(row, profileValues) {
  Object.keys(profileValues).forEach((header) => {
    const index = HEADERS.indexOf(header);
    if (index >= 0) row[index] = profileValues[header];
  });
}

function rowForPayload_(email, payload) {
  const viewport = payload.viewport || {};
  const screen = payload.screen || {};
  const connection = payload.connection || {};
  const geo = payload.geo || {};

  const row = [
    new Date(),
    email,
    payload.source || "",
    payload.submitted_at || "",
    payload.page_url || "",
    payload.referrer || "",
    payload.user_agent || "",
    JSON.stringify(payload.user_agent_data || null),
    payload.language || "",
    Array.isArray(payload.languages) ? payload.languages.join(", ") : "",
    payload.platform || "",
    payload.vendor || "",
    payload.timezone || "",
    valueOrBlank_(payload.timezone_offset_minutes),
    valueOrBlank_(viewport.width),
    valueOrBlank_(viewport.height),
    valueOrBlank_(screen.width),
    valueOrBlank_(screen.height),
    valueOrBlank_(screen.color_depth),
    valueOrBlank_(screen.pixel_depth),
    valueOrBlank_(payload.device_pixel_ratio),
    valueOrBlank_(payload.hardware_concurrency),
    valueOrBlank_(payload.device_memory_gb),
    valueOrBlank_(payload.cookie_enabled),
    payload.do_not_track || "",
    connection.effective_type || "",
    valueOrBlank_(connection.downlink),
    valueOrBlank_(connection.rtt),
    valueOrBlank_(connection.save_data),
    JSON.stringify(payload),
    geo.city || "",
    geo.region || "",
    geo.country || "",
    geo.postal || "",
    // zipcode, reason_interested, lives_alone, alpha_tester,
    // profile_completed_at, and full_name are left empty here and filled by
    // the profile page.
  ];

  // Pad to the full width and set the phone column (last), which lives after
  // the profile columns. Blank for email signups.
  while (row.length < HEADERS.length) row.push("");
  row[HEADERS.indexOf("phone")] = plainTextPhone_(payload.phone);
  row[HEADERS.indexOf("candidate_id")] = candidateId_(payload.candidate_id);
  row[HEADERS.indexOf("waitlist_variant")] = variant_(payload.waitlist_variant);
  return row;
}

function rowForEventPayload_(payload) {
  const viewport = payload.viewport || {};

  return [
    new Date(),
    payload.event_at || "",
    payload.event_type || "",
    payload.session_id || "",
    payload.page_url || "",
    payload.page_path || "",
    payload.page_hash || "",
    payload.referrer || "",
    payload.section_id || "",
    payload.section_label || "",
    payload.element_type || "",
    truncate_(payload.target_text, 500),
    payload.target_href || "",
    payload.target_id || "",
    payload.target_classes || "",
    payload.target_label || "",
    valueOrBlank_(viewport.width),
    valueOrBlank_(viewport.height),
    payload.error || "",
    JSON.stringify(payload),
    valueOrBlank_(payload.has_value),
    valueOrBlank_(payload.looks_valid),
    payload.value_length_bucket || "",
    variant_(payload.waitlist_variant),
  ];
}

function valueOrBlank_(value) {
  return value === undefined || value === null ? "" : value;
}

function truncate_(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
