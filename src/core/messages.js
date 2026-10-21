"use strict";

(function initializeJobCollectorMessages(global) {
  /**
   * @typedef {Object} SiteMessage
   * @property {string} type
   * @property {string} siteId
   * @property {string} [runId]
   *
   * @typedef {SiteMessage & {type:"START_RUN"}} StartRunMessage
   * @typedef {SiteMessage & {type:"STOP_RUN"}} StopRunMessage
   * @typedef {SiteMessage & {type:"SAVE_CAPTURE",record:Object}} SaveCaptureMessage
   * @typedef {SiteMessage & {type:"TOUCH_SEEN_JOBS",jobIds:string[]}} TouchSeenJobsMessage
   * @typedef {SiteMessage & {type:"DIAGNOSTIC_EVENT",event:string,details:Object}} DiagnosticMessage
   * @typedef {SiteMessage & {type:"PAUSE_RUN"|"RESUME_RUN"|"VISIBILITY_TIMEOUT"}} RunControlMessage
   * @typedef {{ok:true}} SuccessResponse
   * @typedef {{ok:false,error:string}} ErrorResponse
   */
  function validateSite(message, siteId) {
    if (!message || message.siteId !== siteId) {
      throw new Error("The message site does not match the active adapter.");
    }
  }

  global.JobCollectorMessages = Object.freeze({ validateSite });
})(globalThis);
