import { AutoComplete, Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { searchRecords, type SearchResult } from "../api/search.js";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import type { ScopeSelection } from "./scope.js";

export function GlobalSearch({ scope }: { scope: ScopeSelection }) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const basePath = readBasePath(document);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const activeHref = useRef<string | null>(null);

  useEffect(() => {
    setQuery("");
    setResults([]);
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    const controller = new AbortController();
    activeHref.current = null;
    setResults([]);
    setFailed(false);
    setLoading(query.trim() !== "");
    if (!query.trim()) return () => controller.abort();
    const timer = setTimeout(() => {
      void searchRecords(basePath, query, scope, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setResults(result.kind === "ok" ? result.value.results : []);
          setFailed(result.kind !== "ok");
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [basePath, query, scope.group, scope.workflow, scope.version, refresh]);

  const options =
    results.length === 0
      ? [
          {
            value: "search-status",
            disabled: true,
            label: loading
              ? t("common.loading")
              : failed
                ? t("search.failed")
                : t("search.empty"),
            context: "",
          },
        ]
      : results.map((result) => ({
          value: result.href,
          label: `${t(`search.kind.${result.kind}`)} · ${result.label}`,
          context: result.context,
          disabled: false,
        }));

  return (
    <div className="top-bar-search">
      <AutoComplete
        style={{ width: "100%" }}
        options={options}
        open={open && !!query.trim()}
        value={query}
        onChange={(value) => {
          setQuery(value);
          setOpen(true);
        }}
        onOpenChange={setOpen}
        onActive={(href) => {
          activeHref.current = href;
        }}
        onSelect={(href) => {
          if (results.some((result) => result.href === href)) navigate(href);
        }}
        defaultActiveFirstOption
        optionRender={(option) =>
          option.data.disabled ? (
            <span role="status">{option.label}</span>
          ) : (
            <div className="search-result">
              <span>{option.label}</span>
              <small>{option.data.context}</small>
            </div>
          )
        }
        popupMatchSelectWidth={420}
        styles={{ popup: { root: { maxWidth: "calc(100vw - 32px)" } } }}
        notFoundContent={
          <span role="status">
            {loading
              ? t("common.loading")
              : failed
                ? t("search.failed")
                : t("search.empty")}
          </span>
        }
      >
        <Input
          allowClear
          maxLength={200}
          prefix={<SearchOutlined aria-hidden="true" />}
          aria-label={t("topBar.search")}
          placeholder={t("topBar.searchPlaceholder")}
          data-testid="search-input"
          onFocus={() => setOpen(true)}
          onPressEnter={(event) => {
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            const selected =
              results.find((result) => result.href === activeHref.current) ??
              results[0];
            if (selected) navigate(selected.href);
            else {
              setRefresh((value) => value + 1);
              setOpen(true);
            }
          }}
        />
      </AutoComplete>
    </div>
  );
}
