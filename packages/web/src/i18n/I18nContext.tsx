import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Language } from "../preferences/model.js";
import { formatMessage, message, type MessageId } from "./catalog.js";

export interface I18n {
  locale: Language;
  t(id: MessageId): string;
  format(
    id: MessageId,
    values: Readonly<Record<string, string | number>>,
  ): string;
}

const I18nContext = createContext<I18n>({
  locale: "en",
  t: (id) => message("en", id),
  format: (id, values) => formatMessage("en", id, values),
});

export function I18nProvider({
  locale,
  children,
}: {
  locale: Language;
  children: ReactNode;
}) {
  const value = useMemo<I18n>(
    () => ({
      locale,
      t: (id) => message(locale, id),
      format: (id, values) => formatMessage(locale, id, values),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
