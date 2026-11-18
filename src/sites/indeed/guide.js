"use strict";

// First-run guide + sample jobs for Indeed India. Loaded only by the welcome tour and results page.
(function registerIndeedGuide(global) {
  const SEARCH_URL = "https://in.indeed.com/jobs?q=software+engineer";
  const DAY = 24 * 60 * 60 * 1000;

  function demoRecords(now) {
    const job = (title, company, location, salary, jobType, easyApply, daysAgo, extra = {}) => ({
      title,
      company,
      location,
      salary,
      jobType,
      easyApplyBadge: easyApply,
      urgentlyHiring: false,
      sponsored: false,
      indeedApplyEnabled: easyApply,
      applied: false,
      saved: false,
      visited: false,
      expired: false,
      remoteWorkText: null,
      parseWarning: null,
      url: SEARCH_URL,
      applyType: easyApply ? "Easy Apply" : "Company Site",
      postedType: "Posted",
      postedText: daysAgo === 0 ? "Today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`,
      postedApprox: false,
      postedDateEstimate: new Date(now - daysAgo * DAY).toISOString(),
      firstSeenAt: new Date(now).toISOString(),
      workMode: null,
      ...extra
    });
    return [
      job("Software Developer", "Acme Analytics", "Hyderabad, Telangana", "₹6,00,000 - ₹9,00,000 a year", "Full-time", true, 0,
        { urgentlyHiring: true }),
      job("React Native Developer", "Northwind Labs", "Bengaluru, Karnataka", "₹50,000 - ₹80,000 a month", "Full-time", true, 1),
      job("Cloud Support Engineer", "Contoso Cloud", "Hyderabad, Telangana", "", "Full-time", false, 2),
      job("PHP / Laravel Developer", "Fabrikam Pay", "Remote", "₹4,00,000 - ₹7,00,000 a year", "Contract", true, 3,
        { workMode: "Remote", remoteWorkText: "Remote" }),
      job("Junior Data Analyst", "Tailspin Toys", "Pune, Maharashtra", "", "Internship", false, 5),
      job("Site Reliability Engineer", "Wide World Importers", "Bengaluru, Karnataka", "₹20,00,000 - ₹30,00,000 a year", "Full-time", false, 8)
    ];
  }

  global.JobCollectorSiteGuides = global.JobCollectorSiteGuides || {};
  global.JobCollectorSiteGuides.indeed = Object.freeze({
    id: "indeed",
    label: "Indeed",
    accent: "#2164f3",
    searchUrl: SEARCH_URL,
    pageHint: "an Indeed India search with a search term (in.indeed.com/jobs?q=…)",
    summary: "Collects Indeed India search results with salary and job type, skipping jobs you've already applied to or that have expired.",
    collects: ["Role and company", "Salary", "Job type (Full-time, Contract…)", "Easily apply vs company site", "Remote flag", "Posted date"],
    steps: [
      {
        title: "Search on in.indeed.com",
        text: "Open in.indeed.com and search with a job title or keyword. The address must contain a search term (…/jobs?q=…)."
      },
      {
        title: "Click Start",
        text: "Click the Job Extensions icon and press Start. It reads the job cards and uses Indeed's own Next page button."
      },
      {
        title: "Skipped automatically",
        text: "Jobs Indeed marks as already applied or expired are skipped, so your list only has jobs you can still apply to."
      },
      {
        title: "Review and apply",
        text: "Open the results page. \"Easy Apply\" jobs use Indeed's quick apply; the rest go to the company's own site."
      }
    ],
    demoRecords
  });
})(globalThis);
