"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = vm.createContext({
  URL,
  window: {
    location: { href: "https://www.linkedin.com/jobs/search-results/" },
    getComputedStyle() {
      return { overflowY: "auto" };
    }
  },
  globalThis: {}
});
vm.runInContext(fs.readFileSync("src/sites/linkedin/selectors.js", "utf8"), context);
const selectors = context.globalThis.JobCollectorSelectors;
const applySelector = `${selectors.SELECTORS.easyApply}, ${selectors.SELECTORS.companyApply}`;

function createLink(jobId) {
  return {
    href: `https://www.linkedin.com/jobs/view/${jobId}/`,
    getAttribute(name) {
      return name === "href" ? this.href : null;
    }
  };
}

function createColumn(name, jobIds, hasDetailApplyControl) {
  const links = jobIds.map(createLink);
  const cards = hasDetailApplyControl
    ? []
    : jobIds.map((jobId) => ({
      tagName: "DIV",
      parentElement: null,
      getAttribute(attribute) {
        return attribute === "componentkey"
          ? `job-card-component-ref-${jobId}`
          : null;
      },
      hasAttribute() {
        return false;
      },
      matches(selector) {
        return selector === selectors.SELECTORS.jobCards;
      },
      querySelectorAll() {
        return [];
      }
    }));
  for (const card of cards) {
    card.parentElement = null;
  }
  const idNodes = jobIds.map((jobId) => ({
    parentElement: null,
    getAttribute(attribute) {
      return attribute === "data-job-id" ? jobId : null;
    }
  }));
  return {
    name,
    scrollHeight: 1800,
    clientHeight: 600,
    getAttribute(attribute) {
      return attribute === "data-testid" ? "lazy-column" : null;
    },
    querySelector(selector) {
      return selector === applySelector && hasDetailApplyControl
        ? {}
        : null;
    },
    querySelectorAll(selector) {
      if (selector === selectors.SELECTORS.jobCards) {
        return cards;
      }
      if (selector === selectors.SELECTORS.jobIds) {
        return idNodes;
      }
      if (selector === selectors.SELECTORS.jobLinks) {
        return links;
      }
      if (selector === applySelector) {
        return hasDetailApplyControl ? [{}] : [];
      }
      return [];
    }
  };
}

const resultsColumn = createColumn("results", ["1", "2", "3", "4"], false);
const detailColumn = createColumn("detail", ["1"], true);
for (const column of [resultsColumn, detailColumn]) {
  for (const node of column.querySelectorAll(selectors.SELECTORS.jobIds)) {
    node.parentElement = column;
  }
}
const document = {
  querySelectorAll(selector) {
    if (selector === selectors.SELECTORS.scrollContainer) {
      return [detailColumn, resultsColumn];
    }
    if (selector === selectors.SELECTORS.jobCards) {
      return resultsColumn.querySelectorAll(selector);
    }
    if (selector === selectors.SELECTORS.jobLinks) {
      return [];
    }
    return [];
  }
};
const selected = selectors.getScrollableContainer(document, []);
assert.equal(selected, resultsColumn);
const candidates = selectors.getCandidateElements(resultsColumn, []);
assert.equal(candidates.length, 4);
assert.deepEqual(
  Array.from(candidates, (card) => (
    selectors.getJobLinkForCard(card, []).jobId
  )),
  ["1", "2", "3", "4"]
);

const listCard = {
  innerText: "Senior Engineer\nAcme Corp\nRemote · 2 days ago · Easy Apply\nActively reviewing applicants",
  getAttribute() {
    return null;
  },
  querySelector(selector) {
    if (selector === selectors.SELECTORS.jobLinks) {
      return { innerText: "Senior Engineer" };
    }
    if (selector === selectors.SELECTORS.companyLinks) {
      return { innerText: "Acme Corp" };
    }
    return selector === selectors.SELECTORS.easyApply ? {} : null;
  },
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.paragraphs
      ? [{ textContent: "Actively reviewing applicants" }]
      : [];
  }
};
assert.deepEqual(
  JSON.parse(JSON.stringify(selectors.getListCardDetails(listCard, []))),
  {
    title: "Senior Engineer",
    company: "Acme Corp",
    metaLine: "Remote · 2 days ago · Easy Apply",
    applyType: "Easy Apply",
    activelyReviewing: true,
    companyLink: { innerText: "Acme Corp" }
  }
);
assert.equal(
  selectors.getListCardDetails({
    innerText: "Senior Engineer\nAcme Corp\nRemote · 2 days ago · Viewed · Easy Apply",
    getAttribute() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  }, []).applyType,
  "Easy Apply"
);
assert.equal(
  selectors.getListCardDetails({
    innerText: "Senior Engineer\nAcme Corp\nRemote · 2 days ago · Apply on company website",
    getAttribute() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  }, []).applyType,
  "Company Site"
);
assert.equal(selectors.isJobAlreadyApplied({
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.paragraphs
      ? [{ textContent: "Applied" }, { textContent: "Be an early applicant" }]
      : [];
  }
}, []), true);
assert.equal(selectors.isJobAlreadyApplied({
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.paragraphs
      ? [{ textContent: "Be an early applicant" }, { textContent: "Easy Apply" }]
      : [];
  }
}, []), false);
assert.equal(selectors.isJobAlreadyApplied({
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.paragraphs
      ? [
        { textContent: "Actively reviewing applicants" },
        { textContent: "Viewed" },
        { textContent: "Easy Apply" }
      ]
      : [];
  }
}, []), false);

const singleResultColumn = createColumn("single-result", ["1"], false);
for (const node of singleResultColumn.querySelectorAll(selectors.SELECTORS.jobIds)) {
  node.parentElement = singleResultColumn;
}
const singleResultDocument = {
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.scrollContainer
      ? [detailColumn, singleResultColumn]
      : [];
  }
};
assert.equal(
  context.globalThis.JobCollectorSelectors.getScrollableContainer(
    singleResultDocument,
    []
  ),
  singleResultColumn
);

const blockingDocument = {
  title: "",
  body: { innerText: "" },
  querySelectorAll() {
    return [];
  },
  querySelector() {
    return null;
  }
};
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/checkpoint/challenge/" }, []),
  /checkpoint or challenge/
);
blockingDocument.title = "Security verification";
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  /identity check/
);
blockingDocument.title = "";
blockingDocument.body.innerText = "Complete the CAPTCHA to continue";
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  /captcha/
);
blockingDocument.body.innerText = "You've reached the limit";
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  /limit warning/
);
blockingDocument.body.innerText = "Something went wrong. Something went wrong.";
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  /Repeated/
);
blockingDocument.body.innerText = "";

const visibleBlockingMarker = {
  hidden: false,
  parentElement: null,
  getAttribute() {
    return null;
  },
  getClientRects() {
    return [{ width: 100, height: 30 }];
  }
};
blockingDocument.querySelectorAll = () => [visibleBlockingMarker];
assert.match(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  /checkpoint or captcha element/
);

const hiddenBlockingMarker = {
  ...visibleBlockingMarker,
  getClientRects() {
    return [];
  }
};
blockingDocument.querySelectorAll = () => [hiddenBlockingMarker];
assert.equal(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  null
);

const jobCardBlockingMarker = {
  ...visibleBlockingMarker,
  parentElement: {
    matches(selector) {
      return selector === selectors.SELECTORS.jobCards;
    },
    parentElement: null
  }
};
blockingDocument.querySelectorAll = () => [jobCardBlockingMarker];
assert.equal(
  selectors.detectBlockingPage(blockingDocument, { pathname: "/jobs/search-results/" }, []),
  null
);

const fallbackLink = createLink("9");
const fallbackResultsColumn = {
  name: "fallback-results",
  scrollHeight: 1500,
  clientHeight: 600,
  parentElement: null,
  getAttribute() {
    return null;
  },
  querySelector(selector) {
    return selector === applySelector ? null : null;
  },
  querySelectorAll(selector) {
    return selector === selectors.SELECTORS.jobLinks ? [fallbackLink] : [];
  }
};
fallbackLink.parentElement = fallbackResultsColumn;
const fallbackDocument = {
  documentElement: {},
  querySelector(selector) {
    if (selector === applySelector) {
      return null;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector === selectors.SELECTORS.scrollContainer) {
      return [];
    }
    if (selector === selectors.SELECTORS.jobLinks) {
      return [fallbackLink];
    }
    return [];
  }
};
assert.equal(
  context.globalThis.JobCollectorSelectors.getScrollableContainer(
    fallbackDocument,
    []
  ),
  fallbackResultsColumn
);

console.log("Scroll-container tests passed: results list wins over the detail pane and unknown test IDs.");
