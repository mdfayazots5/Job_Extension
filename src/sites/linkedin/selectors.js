"use strict";

(() => {
  const SELECTORS = Object.freeze({
    jobLinks: 'a[href*="/jobs/view/"]',
    jobIds: "[data-occludable-job-id], [data-job-id]",
    jobCards: '[role="button"][componentkey^="job-card-component-ref-"]',
    paragraphs: "p",
    scrollContainer: '[data-testid="lazy-column"]',
    semanticCards: '[role="article"], [role="listitem"]',
    easyApply: 'button[aria-label="Easy Apply to this job"]',
    companyApply: 'a[aria-label="Apply on company website"]',
    companyLinks: 'a[href*="/company/"]',
    companyLogoImages: "img",
    blockingMarkers: [
      '[data-testid*="checkpoint" i]',
      '[data-testid*="captcha" i]',
      '[data-testid*="challenge" i]',
      '[data-testid*="verification" i]',
      'iframe[title*="captcha" i]',
      'input[name*="captcha" i]'
    ].join(", "),
    pagerList: '[data-testid="pagination-controls-list"]',
    pageButtons: 'button[aria-label^="Page "]',
    nextButton: 'button[data-testid^="pagination-controls-next-button"]',
    prevButton: 'button[data-testid^="pagination-controls-prev-button"]'
  });

  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function safeQueryAll(root, selector, label, errors) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (error) {
      errors.push({
        step: label,
        selector,
        message: describeError(error)
      });
      return [];
    }
  }

  function safeQuery(root, selector, label, errors) {
    try {
      return root.querySelector(selector);
    } catch (error) {
      errors.push({
        step: label,
        selector,
        message: describeError(error)
      });
      return null;
    }
  }

  function isVisibleBlockingMarker(element, errors) {
    try {
      let ancestor = element;
      while (ancestor) {
        if (
          ancestor.hidden
          || (typeof ancestor.getAttribute === "function"
            && ancestor.getAttribute("aria-hidden") === "true")
        ) {
          return false;
        }
        if (
          ancestor !== element
          && typeof ancestor.matches === "function"
          && ancestor.matches(SELECTORS.jobCards)
        ) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }

      if (typeof element.getClientRects !== "function") {
        errors.push({
          step: "check checkpoint marker visibility",
          selector: SELECTORS.blockingMarkers,
          message: "The matched element does not expose rendered bounds."
        });
        return false;
      }
      const rects = element.getClientRects();
      if (!rects.length) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && style.opacity !== "0";
    } catch (error) {
      errors.push({
        step: "check checkpoint marker visibility",
        selector: SELECTORS.blockingMarkers,
        message: describeError(error)
      });
      return false;
    }
  }

  function isIgnored(element, errors) {
    try {
      let ancestor = element;
      while (ancestor) {
        if (ancestor.id === "tailor-resume-btn") {
          return true;
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    } catch (error) {
      errors.push({
        step: "ignore injected referral button",
        selector: "injected referral-button ancestor check",
        message: describeError(error)
      });
      return false;
    }
  }

  function getCandidateElements(document, errors) {
    const candidates = [];
    const seen = new Set();
    const matchedNodes = [
      ...safeQueryAll(document, SELECTORS.jobIds, "find job-id candidates", errors),
      ...safeQueryAll(document, SELECTORS.jobCards, "find semantic job cards", errors),
      ...safeQueryAll(document, SELECTORS.jobLinks, "find job links", errors)
    ];

    for (const matchedNode of matchedNodes) {
      try {
        if (isIgnored(matchedNode, errors)) {
          continue;
        }

        let candidate = matchedNode;

        if (matchedNode.matches(SELECTORS.jobLinks)) {
          let ancestor = matchedNode.parentElement;
          let semanticCard = null;

          while (ancestor) {
            if (isIgnored(ancestor, errors)) {
              break;
            }

            const hasJobId = ancestor.hasAttribute("data-occludable-job-id")
              || ancestor.hasAttribute("data-job-id");
            if (hasJobId) {
              candidate = ancestor;
              break;
            }

            if (!semanticCard && ancestor.matches(SELECTORS.semanticCards)) {
              semanticCard = ancestor;
            }
            ancestor = ancestor.parentElement;
          }

          if (candidate === matchedNode) {
            candidate = semanticCard || matchedNode.parentElement || matchedNode;
          }
        }

        if (!isIgnored(candidate, errors) && !seen.has(candidate)) {
          seen.add(candidate);
          candidates.push(candidate);
        }
      } catch (error) {
        errors.push({
          step: "resolve candidate card",
          selector: SELECTORS.jobCards,
          message: describeError(error)
        });
      }
    }

    return candidates;
  }

  function getJobIdFromHref(href) {
    if (typeof href !== "string") {
      return null;
    }

    try {
      const url = new URL(href, window.location.href);
      const match = url.pathname.match(/\/jobs\/view\/(\d+)(?:\/|$)/);
      return match ? match[1] : url.searchParams.get("currentJobId");
    } catch (_error) {
      const match = href.match(/\/jobs\/view\/(\d+)(?:\/|$)/);
      return match ? match[1] : null;
    }
  }

  function getJobIdFromCard(card) {
    try {
      const componentKey = card.getAttribute("componentkey") || "";
      const match = componentKey.match(/^job-card-component-ref-(\d+)$/);
      if (match) {
        return match[1];
      }

      const dataJobId = card.getAttribute("data-occludable-job-id")
        || card.getAttribute("data-job-id");
      return dataJobId && /^\d+$/.test(dataJobId) ? dataJobId : null;
    } catch (_error) {
      return null;
    }
  }

  function getJobLinkForCard(card, errors) {
    const links = safeQueryAll(card, SELECTORS.jobLinks, "find job link in card", errors);
    for (const link of links) {
      try {
        const jobId = getJobIdFromHref(link.href || link.getAttribute("href"));
        if (jobId) {
          return { link, jobId };
        }
      } catch (error) {
        errors.push({
          step: "read job link from card",
          selector: SELECTORS.jobLinks,
          message: describeError(error)
        });
      }
    }

    const cardJobId = getJobIdFromCard(card);
    if (cardJobId) {
      return { link: null, jobId: cardJobId };
    }

    try {
      if (card.matches(SELECTORS.jobLinks)) {
        const jobId = getJobIdFromHref(card.href || card.getAttribute("href"));
        return jobId ? { link: card, jobId } : null;
      }
    } catch (error) {
      errors.push({
        step: "check candidate card link",
        selector: SELECTORS.jobLinks,
        message: describeError(error)
      });
    }

    return null;
  }

  function getCardForJobLink(link) {
    let candidate = link;
    let semanticCard = null;

    while (candidate.parentElement) {
      const ancestor = candidate.parentElement;
      if (
        ancestor.hasAttribute("data-occludable-job-id")
        || ancestor.hasAttribute("data-job-id")
      ) {
        return ancestor;
      }

      if (!semanticCard && ancestor.matches(SELECTORS.semanticCards)) {
        semanticCard = ancestor;
      }
      candidate = ancestor;
    }

    return semanticCard || link.parentElement || link;
  }

  function escapeAttributeValue(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\a ")
      .replace(/\r/g, "\\d ");
  }

  function selectorSuggestion(element, document, errors) {
    try {
      const attributes = [
        ["data-occludable-job-id", element.getAttribute("data-occludable-job-id")],
        ["data-job-id", element.getAttribute("data-job-id")],
        ["data-testid", element.getAttribute("data-testid")],
        ["aria-label", element.getAttribute("aria-label")],
        ["role", element.getAttribute("role")]
      ];

      for (const [name, value] of attributes) {
        if (!value) {
          continue;
        }

        const selector = `[${name}="${escapeAttributeValue(value)}"]`;
        const matches = safeQueryAll(document, selector, "verify selector suggestion", errors);
        if (matches.length === 1 && matches[0] === element) {
          return selector;
        }
      }

      return element.tagName.toLowerCase();
    } catch (error) {
      errors.push({
        step: "suggest stable selector",
        selector: "stable attribute selector",
        message: describeError(error)
      });
      return element.tagName ? element.tagName.toLowerCase() : null;
    }
  }

  function describeElement(element, document, errors) {
    if (!element) {
      return null;
    }

    try {
      let overflowY = null;
      try {
        overflowY = window.getComputedStyle(element).overflowY;
      } catch (error) {
        errors.push({
          step: "describe diagnostic element",
          selector: "element computed overflow-y",
          message: describeError(error)
        });
      }

      return {
        tag: element.tagName.toLowerCase(),
        selector: selectorSuggestion(element, document, errors),
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("role"),
        ariaLabel: (element.getAttribute("aria-label") || "").slice(0, 120),
        overflowY,
        scrollTop: Math.round(element.scrollTop || 0),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      };
    } catch (error) {
      errors.push({
        step: "describe diagnostic element",
        selector: "element attributes and scroll metrics",
        message: describeError(error)
      });
      return {
        tag: element.tagName ? element.tagName.toLowerCase() : "unknown"
      };
    }
  }

  function findNearestScrollableAncestor(element, errors) {
    try {
      let ancestor = element.parentElement;

      while (ancestor) {
        try {
          const overflowY = window.getComputedStyle(ancestor).overflowY;
          if (
            (overflowY === "auto" || overflowY === "scroll")
            && ancestor.scrollHeight > ancestor.clientHeight
          ) {
            return ancestor;
          }
        } catch (error) {
          errors.push({
            step: "inspect scrollable ancestor",
            selector: "ancestor computed overflow-y",
            message: describeError(error)
          });
        }

        ancestor = ancestor.parentElement;
      }

      return null;
    } catch (error) {
      errors.push({
        step: "find nearest scrollable ancestor",
        selector: "candidate card ancestors",
        message: describeError(error)
      });
      return null;
    }
  }

  function findDetailPane(document, errors) {
    const applySelector = `${SELECTORS.easyApply}, ${SELECTORS.companyApply}`;
    const applyButtons = safeQueryAll(document, applySelector, "find apply buttons", errors);

    for (const applyButton of applyButtons) {
      try {
        if (isIgnored(applyButton, errors)) {
          continue;
        }

        let ancestor = applyButton.parentElement;
        while (ancestor) {
          const companyLink = safeQuery(
            ancestor,
            SELECTORS.companyLinks,
            "find company link in detail pane",
            errors
          );
          const jobLink = safeQuery(
            ancestor,
            SELECTORS.jobLinks,
            "find job title link in detail pane",
            errors
          );

          if (companyLink && jobLink) {
            return ancestor;
          }

          ancestor = ancestor.parentElement;
        }
      } catch (error) {
        errors.push({
          step: "walk up from apply button",
          selector: applySelector,
          message: describeError(error)
        });
      }
    }

    return null;
  }

  function findDetailPaneForJob(document, jobId, errors) {
    const applySelector = `${SELECTORS.easyApply}, ${SELECTORS.companyApply}`;
    const applyButtons = safeQueryAll(document, applySelector, "find detail apply controls", errors);

    for (const applyButton of applyButtons) {
      try {
        if (isIgnored(applyButton, errors)) {
          continue;
        }

        let ancestor = applyButton.parentElement;
        while (ancestor) {
          const companyLink = safeQuery(
            ancestor,
            SELECTORS.companyLinks,
            "find company link in detail pane",
            errors
          );
          const titleLinks = safeQueryAll(
            ancestor,
            SELECTORS.jobLinks,
            "find job title link in detail pane",
            errors
          );
          if (companyLink && titleLinks.some((link) => {
            try {
              return getJobIdFromHref(link.href || link.getAttribute("href")) === jobId;
            } catch (error) {
              errors.push({
                step: "read detail title job ID",
                selector: SELECTORS.jobLinks,
                message: describeError(error)
              });
              return false;
            }
          })) {
            return ancestor;
          }
          ancestor = ancestor.parentElement;
        }
      } catch (error) {
        errors.push({
          step: "walk up from detail apply control",
          selector: applySelector,
          message: describeError(error)
        });
      }
    }

    const titleLinks = safeQueryAll(
      document,
      SELECTORS.jobLinks,
      "find detail title link without apply control",
      errors
    );
    for (const titleLink of titleLinks) {
      try {
        if (getJobIdFromHref(titleLink.href || titleLink.getAttribute("href")) !== jobId) {
          continue;
        }

        let ancestor = titleLink.parentElement;
        while (ancestor) {
          if (safeQuery(
            ancestor,
            SELECTORS.companyLinks,
            "find company link in apply-less detail pane",
            errors
          )) {
            return ancestor;
          }
          ancestor = ancestor.parentElement;
        }
      } catch (error) {
        errors.push({
          step: "find apply-less detail pane",
          selector: SELECTORS.jobLinks,
          message: describeError(error)
        });
      }
    }

    return null;
  }

  function getDetailTitleLink(root, jobId, errors) {
    const links = safeQueryAll(root, SELECTORS.jobLinks, "find detail title", errors);
    for (const link of links) {
      try {
        if (getJobIdFromHref(link.href || link.getAttribute("href")) === jobId) {
          return link;
        }
      } catch (error) {
        errors.push({
          step: "read detail title href",
          selector: SELECTORS.jobLinks,
          message: describeError(error)
        });
      }
    }
    return null;
  }

  function getDetailCompanyLink(root, errors) {
    const links = safeQueryAll(root, SELECTORS.companyLinks, "find detail company name", errors);
    return links.find((link) => safeQuery(
      link,
      SELECTORS.companyLogoImages,
      "find company logo link in detail pane",
      errors
    )) || links[0] || null;
  }

  function getDetailCompanyName(root, errors) {
    const links = safeQueryAll(root, SELECTORS.companyLinks, "find detail company name", errors);
    for (const link of links) {
      const name = (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim();
      if (name) {
        return name;
      }
    }
    return "";
  }

  function getDetailCompanyLogoUrl(companyLink, errors) {
    const image = safeQuery(
      companyLink,
      SELECTORS.companyLogoImages,
      "find company logo image",
      errors
    );
    if (!image) {
      return null;
    }

    try {
      const source = image.currentSrc || image.getAttribute("src") || image.src;
      if (!source) {
        return null;
      }
      const url = new URL(source, window.location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (error) {
      errors.push({
        step: "read company logo URL",
        selector: SELECTORS.companyLogoImages,
        message: describeError(error)
      });
      return null;
    }
  }

  function getListCardDetails(card, errors) {
    try {
      const titleLink = safeQuery(
        card,
        SELECTORS.jobLinks,
        "find job title in result card",
        errors
      );
      const companyLink = safeQuery(
        card,
        SELECTORS.companyLinks,
        "find company in result card",
        errors
      );
      const text = card.innerText || card.textContent || "";
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const title = (titleLink && (titleLink.innerText || titleLink.textContent))
        || card.getAttribute("aria-label")
        || lines[0]
        || "";
      const company = companyLink
        ? (companyLink.innerText || companyLink.textContent || "")
        : (lines[1] || "");
      const easyApply = Boolean(safeQuery(
        card,
        SELECTORS.easyApply,
        "find Easy Apply indicator in result card",
        errors
      ));
      const companyApply = Boolean(safeQuery(
        card,
        SELECTORS.companyApply,
        "find company apply indicator in result card",
        errors
      ));
      const normalizedText = text.toLocaleLowerCase();
      const activelyReviewing = isActivelyReviewingApplicants(card, errors);
      const applyType = easyApply || /\beasy apply\b/i.test(normalizedText)
        ? "Easy Apply"
        : (companyApply || /apply on company website|company site/i.test(normalizedText)
          ? "Company Site"
          : "Unknown");
      const metaLine = lines.find((line) => line.includes("·")) || "";
      return {
        title: String(title).trim(),
        company: String(company).trim(),
        metaLine,
        applyType,
        activelyReviewing,
        companyLink
      };
    } catch (error) {
      errors.push({
        step: "read list-card details",
        selector: SELECTORS.jobCards,
        message: describeError(error)
      });
      return {
        title: "",
        company: "",
        metaLine: "",
        applyType: "Unknown",
        activelyReviewing: false,
        companyLink: null
      };
    }
  }

  function isActivelyReviewingApplicants(root, errors) {
    return safeQueryAll(
      root,
      SELECTORS.paragraphs,
      "find applicant-review status",
      errors
    ).some((paragraph) => (
      (paragraph.innerText || paragraph.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase() === "actively reviewing applicants"
    ));
  }

  function isJobAlreadyApplied(root, errors) {
    return safeQueryAll(
      root,
      SELECTORS.paragraphs,
      "find applied status",
      errors
    ).some((paragraph) => (
      (paragraph.innerText || paragraph.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase() === "applied"
    ));
  }

  function getDetailApplyControls(root, errors) {
    return {
      easyApply: safeQuery(
        root,
        SELECTORS.easyApply,
        "find Easy Apply control in detail pane",
        errors
      ),
      companyApply: safeQuery(
        root,
        SELECTORS.companyApply,
        "find company apply link in detail pane",
        errors
      )
    };
  }

  function getScrollableContainer(document, errors) {
    const isScrollable = (element, selector) => {
      try {
        const overflowY = window.getComputedStyle(element).overflowY;
        return (overflowY === "auto" || overflowY === "scroll")
          && element.scrollHeight > element.clientHeight;
      } catch (error) {
        errors.push({
          step: "inspect scroll container",
          selector,
          message: describeError(error)
        });
        return false;
      }
    };

    const detailPane = findDetailPane(document, errors);
    const resultsCandidates = safeQueryAll(
      document,
      SELECTORS.scrollContainer,
      "find known results scroll containers",
      errors
    );
    const candidates = new Set(resultsCandidates);
    const jobNodes = [
      ...safeQueryAll(
        document,
        SELECTORS.jobIds,
        "find job-ID nodes for scroll-container fallback",
        errors
      ),
      ...safeQueryAll(
        document,
        SELECTORS.jobCards,
        "find semantic cards for scroll-container fallback",
        errors
      ),
      ...safeQueryAll(
        document,
        SELECTORS.jobLinks,
        "find links for scroll-container fallback",
        errors
      )
    ];
    for (const node of jobNodes) {
      let ancestor = node.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        if (isScrollable(ancestor, "job link ancestor overflow-y")) {
          candidates.add(ancestor);
        }
        ancestor = ancestor.parentElement;
      }
    }

    const rankedColumns = [];
    for (const container of candidates) {
      if (!isScrollable(container, SELECTORS.scrollContainer)) {
        continue;
      }

      const containedJobIdNodes = safeQueryAll(
        container,
        SELECTORS.jobIds,
        "count job-ID nodes in scroll container",
        errors
      );
      const containedJobCards = safeQueryAll(
        container,
        SELECTORS.jobCards,
        "count semantic job cards in scroll container",
        errors
      );
      const containedJobLinks = safeQueryAll(
        container,
        SELECTORS.jobLinks,
        "count job links in scroll container",
        errors
      );
      const jobIds = new Set();
      for (const node of containedJobIdNodes) {
        const jobId = node.getAttribute("data-occludable-job-id")
          || node.getAttribute("data-job-id");
        if (jobId) {
          jobIds.add(jobId);
        }
      }
      for (const card of containedJobCards) {
        const jobId = getJobIdFromCard(card);
        if (jobId) {
          jobIds.add(jobId);
        }
      }
      for (const link of containedJobLinks) {
        const jobId = getJobIdFromHref(link.href || link.getAttribute("href"));
        if (jobId) {
          jobIds.add(jobId);
        }
      }

      const containsDetailPane = Boolean(
        detailPane
        && (
          container === detailPane
          || (typeof container.contains === "function" && container.contains(detailPane))
        )
      );
      const hasDetailApplyControl = Boolean(safeQuery(
        container,
        `${SELECTORS.easyApply}, ${SELECTORS.companyApply}`,
        "exclude detail pane from results scroll containers",
        errors
      ));
      rankedColumns.push({
        container,
        jobCount: jobIds.size,
        isResultsColumn: container.getAttribute("data-testid") === "lazy-column",
        isDetailColumn: containsDetailPane || hasDetailApplyControl
      });
    }

    rankedColumns.sort((left, right) => {
      if (left.isDetailColumn !== right.isDetailColumn) {
        return left.isDetailColumn ? 1 : -1;
      }
      if (left.jobCount !== right.jobCount) {
        return right.jobCount - left.jobCount;
      }
      if (left.isResultsColumn !== right.isResultsColumn) {
        return left.isResultsColumn ? -1 : 1;
      }
      return 0;
    });
    if (
      rankedColumns.length > 0
      && rankedColumns[0].jobCount > 0
      && !rankedColumns[0].isDetailColumn
    ) {
      return rankedColumns[0].container;
    }
    return null;
  }

  function detectBlockingPage(document, location, errors) {
    try {
      const path = `${location.pathname}${location.search}`.toLowerCase();
      if (/\/(checkpoint|challenge|captcha|authwall|login|uas)(?:\/|[?&]|$)/.test(path)) {
        return "LinkedIn checkpoint or challenge page detected.";
      }

      const blockingMarkers = safeQueryAll(
        document,
        SELECTORS.blockingMarkers,
        "find checkpoint/captcha markers",
        errors
      );
      if (blockingMarkers.some((marker) => isVisibleBlockingMarker(marker, errors))) {
        return "LinkedIn checkpoint or captcha element detected.";
      }

      const bodyText = document.body
        ? (document.body.innerText || document.body.textContent || "")
        : "";
      const pageText = `${document.title || ""}\n${bodyText}`;
      const markers = [
        ["captcha", /\bcaptcha\b|prove you are human|verify you are human/i],
        ["unusual activity", /unusual activity|automated activity|suspicious activity/i],
        ["identity check", /verify your identity|security verification|verification required|security check/i],
        ["limit warning", /you['’]ve reached the limit|you have reached the limit/i]
      ];
      for (const [label, expression] of markers) {
        if (expression.test(pageText)) {
          return `LinkedIn ${label} detected.`;
        }
      }
      const wrongMessageMatches = pageText.match(/something went wrong/gi) || [];
      if (wrongMessageMatches.length >= 2) {
        return "Repeated LinkedIn 'something went wrong' warning detected.";
      }
    } catch (error) {
      errors.push({
        step: "check checkpoint/captcha page",
        selector: "URL path and page text",
        message: describeError(error)
      });
    }
    return null;
  }

  function getPagerElements(document, errors) {
    const pagerSelectors = [
      ["pagerList", SELECTORS.pagerList],
      ["pageButtons", SELECTORS.pageButtons],
      ["nextButton", SELECTORS.nextButton],
      ["prevButton", SELECTORS.prevButton]
    ];
    const pager = {};

    for (const [key, selector] of pagerSelectors) {
      try {
        pager[key] = safeQueryAll(document, selector, `find pager ${key}`, errors);
      } catch (error) {
        errors.push({
          step: `find pager ${key}`,
          selector,
          message: describeError(error)
        });
        pager[key] = [];
      }
    }

    return pager;
  }

  function getCurrentPageNumber(document, errors) {
    const buttons = safeQueryAll(
      document,
      SELECTORS.pageButtons,
      "find current pagination button",
      errors
    );
    for (const button of buttons) {
      try {
        if (button.getAttribute("aria-current") !== "true") {
          continue;
        }
        const match = (button.getAttribute("aria-label") || "").match(/^Page\s+(\d+)$/i);
        if (match) {
          return Number(match[1]);
        }
      } catch (error) {
        errors.push({
          step: "read current page number",
          selector: SELECTORS.pageButtons,
          message: describeError(error)
        });
      }
    }
    return null;
  }

  function getNextPageControl(document, currentPage, errors) {
    const buttons = safeQueryAll(
      document,
      SELECTORS.nextButton,
      "find next page button",
      errors
    );
    const hasDisabledNext = buttons.length > 0 && buttons.every((button) => {
      try {
        const testId = button.getAttribute("data-testid") || "";
        const style = window.getComputedStyle(button);
        return button.disabled
          || button.getAttribute("aria-disabled") === "true"
          || button.hidden
          || style.display === "none"
          || style.visibility === "hidden"
          || /next-button-hidden$/i.test(testId);
      } catch (error) {
        errors.push({
          step: "check next page button availability",
          selector: SELECTORS.nextButton,
          message: describeError(error)
        });
        return false;
      }
    });

    if (hasDisabledNext) {
      return null;
    }

    if (Number.isInteger(currentPage)) {
      const targetPage = currentPage + 1;
      const pageButtons = safeQueryAll(
        document,
        SELECTORS.pageButtons,
        "find next numbered page button",
        errors
      );
      for (const button of pageButtons) {
        try {
          const label = button.getAttribute("aria-label") || "";
          if (
            label === `Page ${targetPage}`
            && !button.disabled
            && button.getAttribute("aria-disabled") !== "true"
            && button.getAttribute("aria-current") !== "true"
            && !button.hidden
          ) {
            return { button, pageNumber: targetPage, kind: "numbered" };
          }
        } catch (error) {
          errors.push({
            step: "check numbered page button",
            selector: SELECTORS.pageButtons,
            message: describeError(error)
          });
        }
      }
    }

    for (const button of buttons) {
      try {
        const testId = button.getAttribute("data-testid") || "";
        const style = window.getComputedStyle(button);
        if (
          !button.disabled
          && button.getAttribute("aria-disabled") !== "true"
          && !button.hidden
          && style.display !== "none"
          && style.visibility !== "hidden"
          && !/next-button-hidden$/i.test(testId)
        ) {
          return {
            button,
            pageNumber: Number.isInteger(currentPage) ? currentPage + 1 : null,
            kind: "next"
          };
        }
      } catch (error) {
        errors.push({
          step: "check fallback next page button",
          selector: SELECTORS.nextButton,
          message: describeError(error)
        });
      }
    }
    return null;
  }

  globalThis.JobCollectorSelectors = Object.freeze({
    SELECTORS,
    describeError,
    getCandidateElements,
    getJobIdFromHref,
    getJobIdFromCard,
    getJobLinkForCard,
    getCardForJobLink,
    selectorSuggestion,
    describeElement,
    findNearestScrollableAncestor,
    getScrollableContainer,
    findDetailPane,
    findDetailPaneForJob,
    getDetailTitleLink,
    getDetailCompanyLink,
    getDetailCompanyName,
    getDetailCompanyLogoUrl,
    getListCardDetails,
    isActivelyReviewingApplicants,
    isJobAlreadyApplied,
    getDetailApplyControls,
    detectBlockingPage,
    getPagerElements,
    getCurrentPageNumber,
    getNextPageControl
  });
})();
