"use strict";

const assert = require("node:assert/strict");
const metadata = require("../src/sites/linkedin/metadata.js");

const capturedAt = "2026-10-16T12:00:00.000Z";

assert.deepEqual(
  metadata.parseDetailMeta("Toronto, Ontario, Canada · 2 days ago", capturedAt),
  {
    location: "Toronto, Ontario, Canada",
    postedType: "Posted",
    postedText: "2 days ago",
    postedDateEstimate: "2026-10-14"
  }
);

assert.deepEqual(
  metadata.parseDetailMeta("Toronto, Ontario, Canada · Reposted · 2 days ago", capturedAt),
  {
    location: "Toronto, Ontario, Canada",
    postedType: "Reposted",
    postedText: "2 days ago",
    postedDateEstimate: "2026-10-14"
  }
);

assert.equal(
  metadata.parseDetailMeta(
    "Tata Consultancy ServicesDotnet Developer Hyderabad, Telangana, India · 2 days ago",
    capturedAt,
    { company: "Tata Consultancy Services", title: "Dotnet Developer" }
  ).location,
  "Hyderabad, Telangana, India"
);
assert.equal(
  metadata.parseDetailMeta(
    `${"A".repeat(70)} · 2 days ago`,
    capturedAt
  ).location.length,
  60
);

assert.equal(
  metadata.estimatePostedDate("3 weeks ago", capturedAt),
  "2026-09-25"
);
assert.equal(
  metadata.estimatePostedDate("2 months ago", capturedAt),
  "2026-08-16"
);
assert.equal(
  metadata.estimatePostedDate("1 year ago", capturedAt),
  "2025-10-16"
);
assert.equal(
  metadata.estimatePostedTimestamp("15 hours ago", "2026-10-22T10:00:00.000Z"),
  "2026-10-21T19:00:00.000Z"
);
assert.deepEqual(
  metadata.parseDetailMeta(
    "Bengaluru, Karnataka, India · Reposted · 1 year ago · 50 people clicked apply",
    capturedAt
  ),
  {
    location: "Bengaluru, Karnataka, India",
    postedType: "Reposted",
    postedText: "1 year ago",
    postedDateEstimate: "2025-10-16"
  }
);
assert.equal(
  metadata.cleanPostedText("1 year ago · Over 100 people clicked apply"),
  "1 year ago"
);
assert.equal(
  metadata.parseDetailMeta("Toronto · Full-time", capturedAt).postedType,
  "Unknown"
);

console.log("Metadata tests passed: Posted, Reposted, and relative-date estimates.");
