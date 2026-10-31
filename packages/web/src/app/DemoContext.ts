import { createContext, useContext } from "react";

/** Set by the server's demo document, independent of request/query parameters. */
export const DemoContext = createContext(false);
export const useDemoMode = () => useContext(DemoContext);
