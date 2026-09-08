import { createContext, useContext } from "react";
import type { BootstrapData } from "../../shared/contracts";

/** A successful bootstrap refresh invalidates each visible business projection. */
export const BusinessDataContext = createContext<BootstrapData | null>(null);
export const useBusinessVersion = () => useContext(BusinessDataContext);
