"use strict";

// First-run guide + sample jobs for LinkedIn. Loaded only by the welcome tour and results page
// (never by content scripts). Text shown to users lives here so core stays site-agnostic.
(function registerLinkedInGuide(global) {
  const SEARCH_URL = "https://www.linkedin.com/jobs/search-results/?keywords=software%20engineer";
  const DAY = 24 * 60 * 60 * 1000;

  function demoRecords(now) {
    const job = (title, company, location, applyType, daysAgo, extra = {}) => ({
      title,
      company,
      companyLogoUrl: "",
      location,
      url: SEARCH_URL,
      applyType,
      companyApplyUrl: null,
      applicantReviewStatus: daysAgo < 2 ? "actively-reviewing" : "not-indicated",
      postedType: "Posted",
      postedText: daysAgo === 0 ? "Today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`,
      postedDateEstimate: new Date(now - daysAgo * DAY).toISOString(),
      pageNumber: 1,
      ...extra
    });
    return [
      job("Senior Frontend Engineer", "Acme Analytics", "Hyderabad, Telangana, India (Hybrid)", "Easy Apply", 0),
      job("Full Stack Developer (React/Node)", "Northwind Labs", "Bengaluru, Karnataka, India", "Easy Apply", 1),
      job("Software Engineer II", "Contoso Cloud", "Hyderabad, Telangana, India", "Company Site", 2),
      job("Backend Engineer - Payments", "Fabrikam Pay", "Bengaluru, Karnataka, India (Remote)", "Company Site", 3,
        { postedType: "Reposted" }),
      job("QA Automation Engineer", "Tailspin Toys", "Pune, Maharashtra, India", "Easy Apply", 5),
      job("Data Engineer", "Wide World Importers", "Chennai, Tamil Nadu, India", "Company Site", 7)
    ];
  }

  global.JobCollectorSiteGuides = global.JobCollectorSiteGuides || {};
  global.JobCollectorSiteGuides.linkedin = Object.freeze({
    id: "linkedin",
    label: "LinkedIn",
    accent: "#0a66c2",
    searchUrl: SEARCH_URL,
    pageHint: "a LinkedIn Jobs search results page (linkedin.com/jobs/search-results/…)",
    summary: "Collects every job on your LinkedIn Jobs search, page by page, and sorts them into Easy Apply and Company Apply.",
    collects: ["Role and company", "Location", "Posted / Reposted date", "Easy Apply vs company website", "\"Actively reviewing\" signal"],
    steps: [
      {
        title: "Sign in and search",
        text: "Sign in to LinkedIn, open Jobs, type your search (e.g. \"React developer\") and set any filters you like: location, date posted, experience."
      },
      {
        title: "Click Start",
        text: "Click the Job Extensions icon in the toolbar and press Start. It reads each job card, then moves to the next page using LinkedIn's own page buttons."
      },
      {
        title: "Keep the tab visible",
        text: "Leave the LinkedIn tab open and in front while it runs (it pauses in background tabs). Press Stop any time; what was collected is kept."
      },
      {
        title: "Review your list",
        text: "Click View to open the results page. Easy Apply jobs open inside LinkedIn; Company Apply jobs go to the company's own site."
      }
    ],
    demoRecords
  });
})(globalThis);
