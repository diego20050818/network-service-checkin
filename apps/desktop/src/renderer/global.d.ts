import type { CheckinApi } from "../shared/contracts";

declare global {
  interface Window {
    checkinApi: CheckinApi;
  }
}

export {};

