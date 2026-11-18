"use strict";

// First-run guide + sample jobs for Naukri. Loaded only by the welcome tour and results page.
(function registerNaukriGuide(global) {
  const SEARCH_URL = "https://www.naukri.com/software-engineer-jobs";
  const DAY = 24 * 60 * 60 * 1000;

  function demoRecords(now) {
    const job = (title, company, city, experience, salary, companyApply, daysAgo, extra = {}) => ({
      title,
      url: SEARCH_URL,
      company,
      postedBy: company,
      logo: "",
      experience,
      salary,
      locationRaw: city,
      workMode: null,
      locations: [city],
      walkIn: false,
      walkInDates: null,
      postedText: daysAgo === 0 ? "Just now" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`,
      postedDateEstimate: new Date(now - daysAgo * DAY).toISOString(),
      postedApprox: false,
      postedType: "Posted",
      applyType: "Naukri",
      companyApplyJob: companyApply,
      questionnaireIdPresent: false,
      applyRedirectUrl: null,
      ...extra
    });
    return [
      job("Java Developer", "Acme Analytics", "Hyderabad", "3-6 Yrs", "8-14 Lacs PA", false, 0),
      job("Angular Frontend Developer", "Northwind Labs", "Bengaluru", "2-5 Yrs", "Not disclosed", false, 1),
      job("Python Backend Engineer", "Contoso Cloud", "Hyderabad", "4-8 Yrs", "15-25 Lacs PA", true, 2,
        { workMode: "Hybrid" }),
      job(".NET Full Stack Developer", "Fabrikam Pay", "Pune", "5-10 Yrs", "18-28 Lacs PA", true, 3),
      job("Manual & Automation Tester", "Tailspin Toys", "Bengaluru", "1-3 Yrs", "4-7 Lacs PA", false, 4,
        { walkIn: true, walkInDates: "Walk-in this week" }),
      job("DevOps Engineer", "Wide World Importers", "Chennai", "6-9 Yrs", "20-30 Lacs PA", true, 6)
    ];
  }

  global.JobCollectorSiteGuides = global.JobCollectorSiteGuides || {};
  global.JobCollectorSiteGuides.naukri = Object.freeze({
    id: "naukri",
    label: "Naukri",
    accent: "#4a90e2",
    searchUrl: SEARCH_URL,
    pageHint: "a Naukri search results page (any naukri.com/…-jobs address)",
    summary: "Collects Naukri search results with experience, salary and walk-in details, split into Easy Apply (on Naukri) and Company Apply.",
    collects: ["Role and company", "Experience range", "Salary", "Location / work mode", "Walk-in drives", "Posted date"],
    steps: [
      {
        title: "Search on Naukri",
        text: "Sign in to Naukri and run a job search (for example \"java developer jobs in Hyderabad\"). Add filters such as experience or freshness if you like."
      },
      {
        title: "Click Start",
        text: "On the results page, click the Job Extensions icon and press Start. It reads the listings and steps through Naukri's own page numbers."
      },
      {
        title: "Use the extra filters",
        text: "On the results page, Naukri jobs can be filtered by location (Hyderabad / Bengaluru / other) and experience band (3Y and below, 4-5Y, 6Y+)."
      },
      {
        title: "Apply from the list",
        text: "Easy Apply jobs open on Naukri; Company Apply jobs open the employer's application page. Jobs you opened are marked so you don't apply twice."
      }
    ],
    demoRecords
  });
})(globalThis);
