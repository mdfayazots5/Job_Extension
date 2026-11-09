"use strict";

// Shared, site-agnostic text matching for everything a user types to find or skip jobs
// (results search, exported report search, Skip Title). No term-specific rules: matching works the same
// for any word, the way a user expects:
//   - case and accents are ignored                         ("ENGINEER" = "engineer", "é" = "e")
//   - spacing, hyphens and punctuation are ignored         ("Front-End" = "front end" = "frontend")
//   - symbols match their spoken names                     ("C#" = "c sharp" = "csharp",
//                                                            "C++" = "cplusplus", ".NET" = "dot net" = "dotnet")
//   - complete words match whole words                     ("Java" does not match "JavaScript")
//   - a partial word matches word starts (partial mode)    ("angu" finds "Angular")
(function initializeJobCollectorTextMatch(global) {
  function createTextMatch() {
    const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
    const cache = new Map();
    const CACHE_LIMIT = 50000;

    function fold(value) {
      return String(value || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLocaleLowerCase();
    }

    function spellSymbols(text, everyDot) {
      const dotPattern = everyDot
        // In job text, any dot directly before a letter/digit may be spoken ("asp.net" -> "asp dot net").
        ? /\.(?=[\p{L}\p{N}])/gu
        // In what the user types, only a dot that starts a word is spoken (".net"); inner dots
        // ("node.js", "asp.net") are separators so "nodejs" and "node js" still match.
        : /(^|[^\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu;
      return text
        .replace(/#/g, " sharp ")
        .replace(/\+/g, " plus ")
        .replace(dotPattern, everyDot ? " dot " : "$1 dot ");
    }

    function toWords(text) {
      return text.split(WORD_SPLIT).filter(Boolean);
    }

    // Compact key for a query or a title: words joined without separators.
    function keyOf(value) {
      return toWords(spellSymbols(fold(value), false)).join("");
    }

    function compile(words) {
      let joined = "";
      const starts = new Set();
      const ends = new Set();
      for (const word of words) {
        starts.add(joined.length);
        joined += word;
        ends.add(joined.length);
      }
      return { joined, starts, ends };
    }

    // Two views of the job text: symbols as separators, and symbols spelled out.
    function formsOf(text) {
      const cached = cache.get(text);
      if (cached) {
        return cached;
      }
      const folded = fold(text);
      const forms = [compile(toWords(folded)), compile(toWords(spellSymbols(folded, true)))];
      if (cache.size >= CACHE_LIMIT) {
        cache.clear();
      }
      cache.set(text, forms);
      return forms;
    }

    function matchesForm(form, key, partialWords) {
      let index = form.joined.indexOf(key);
      while (index !== -1) {
        if (form.starts.has(index) && (partialWords || form.ends.has(index + key.length))) {
          return true;
        }
        index = form.joined.indexOf(key, index + 1);
      }
      return false;
    }

    // True when `text` contains `query` under the rules above.
    function matchesText(text, query, options = {}) {
      if (typeof text !== "string" || text === "") {
        return false;
      }
      const key = keyOf(query);
      if (!key) {
        // Query made only of symbols with no spoken name (e.g. "&"): plain substring.
        const raw = fold(query).trim();
        return raw === "" || fold(text).includes(raw);
      }
      return formsOf(text).some((form) => matchesForm(form, key, options.partialWords === true));
    }

    function matchesAny(fields, query, options = {}) {
      return (Array.isArray(fields) ? fields : []).some((field) => matchesText(field, query, options));
    }

    // Equality key for de-duplicating titles: "Sr. .NET Developer" = "sr dotnet developer".
    function titleKey(value) {
      return keyOf(value);
    }

    // Skip Title rule ("LIKE" match): returns the first phrase that the title CONTAINS as whole
    // words under the rules above, or null. "Test Engineer" skips "Senior Test Engineer - QA";
    // "Java" does not skip "JavaScript Developer". Phrases with no letters/digits are ignored.
    function findContainedPhrase(title, phrases) {
      if (typeof title !== "string" || !keyOf(title) || !Array.isArray(phrases)) {
        return null;
      }
      for (const phrase of phrases) {
        if (typeof phrase === "string" && keyOf(phrase) && matchesText(title, phrase)) {
          return phrase;
        }
      }
      return null;
    }

    return Object.freeze({ matchesText, matchesAny, titleKey, findContainedPhrase });
  }

  const api = createTextMatch();
  global.JobCollectorTextMatch = Object.freeze({
    ...api,
    // Source of the factory, so the self-contained exported report can embed the same rules.
    factorySource: createTextMatch.toString()
  });
})(globalThis);
