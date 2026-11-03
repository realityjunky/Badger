import {
  Alert,
  Button,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  theme,
} from "antd";
import { useEffect, useRef, useState } from "react";
import {
  loadLlm,
  reloadLlm,
  saveLlm,
  testLlm,
  type LlmSettings,
  type ModelConnection,
  type ModelSetting,
  type SecretChange,
  type SettingValue,
} from "../../api/llm.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { isRecord } from "../../util/records.js";

const basicDescriptors: ModelSetting[] = [
  {
    key: "context",
    label: "Input/context budget (tokens)",
    type: "integer",
    minimum: 1024,
    maximum: 2000000,
    default: 32000,
    mapping: { target: "context-budget" },
  },
  {
    key: "output",
    label: "Maximum output tokens",
    type: "integer",
    minimum: 256,
    maximum: 200000,
    default: 4096,
    mapping: { target: "max_tokens" },
  },
];

export function LlmConfigurationPanel() {
  const { t } = useI18n();
  const { token } = theme.useToken();
  const basePath = readBasePath(document);
  const [saved, setSaved] = useState<LlmSettings | null>(null);
  const [draft, setDraft] = useState<LlmSettings["configuration"] | null>(null);
  const [secrets, setSecrets] = useState<Record<string, SecretChange>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<string | null>(null);
  const [connectionNotices, setConnectionNotices] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({});
  const feedback = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => setConnectionNotices({}), [draft]);
  useEffect(() => {
    if (lastTest)
      feedback.current
        .get(lastTest)
        ?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [connectionNotices, lastTest]);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved?.configuration) ||
    Object.keys(secrets).length > 0;

  function accept(value: LlmSettings) {
    setSaved(value);
    setDraft(value.configuration);
    setSecrets({});
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadLlm(basePath, controller.signal)
      .then(accept)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t("llm.failed"));
      });
    return () => controller.abort();
  }, [basePath, t]);

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("llm.failed"));
    } finally {
      setBusy(false);
    }
  }
  async function testConnection(id: string) {
    if (!saved || busy || dirty) return;
    setBusy(true);
    setTesting(id);
    setLastTest(id);
    setConnectionNotices((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await testLlm(basePath, saved.revision, id);
      setConnectionNotices((current) => ({
        ...current,
        [id]: { type: "success", message: result.message },
      }));
    } catch (failure) {
      setConnectionNotices((current) => ({
        ...current,
        [id]: {
          type: "error",
          message: failure instanceof Error ? failure.message : t("llm.failed"),
        },
      }));
    } finally {
      setBusy(false);
      setTesting(null);
    }
  }

  function updateModel(id: string, patch: Partial<ModelConnection>) {
    setDraft(
      (current) =>
        current && {
          ...current,
          models: current.models.map((m) =>
            m.id === id ? { ...m, ...patch } : m,
          ),
        },
    );
  }
  async function importProfiles(file: File | undefined) {
    if (!file) return;
    await perform(async () => {
      if (file.size > 262144) throw new Error(t("llm.importFailed"));
      const value: unknown = JSON.parse(await file.text());
      if (!isRecord(value)) throw new Error(t("llm.importFailed"));
      const profiles = isRecord(value.configuration)
        ? value.configuration
        : value;
      const models = profiles.models;
      if (
        !Array.isArray(models) ||
        !models.length ||
        !models.every(renderableModel)
      )
        throw new Error(t("llm.importFailed"));
      if (
        models.some((m) =>
          draft?.models.some((existing) => existing.id === m.id),
        ) ||
        new Set(models.map((m) => m.id)).size !== models.length
      )
        throw new Error(t("llm.duplicateProfile"));
      setDraft(
        (current) =>
          current && { ...current, models: [...current.models, ...models] },
      );
    });
  }
  function exportConfiguration() {
    if (!saved) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { revision: saved.revision, configuration: saved.configuration },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "badger-llm.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!draft || !saved)
    return error ? (
      <Alert type="error" title={error} />
    ) : (
      <p role="status">{t("common.loading")}</p>
    );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        width: "100%",
        minWidth: 0,
      }}
    >
      <p>
        {t("llm.adminHelp")} <code>{saved.revision}</code>
      </p>
      <section className="skills-full-width">
        <h2>{t("llm.connections")}</h2>
        <Space wrap>
          <Button
            disabled={busy}
            onClick={() => {
              const id = `model-${crypto.randomUUID().slice(0, 8)}`;
              setDraft({
                ...draft,
                models: [
                  ...draft.models,
                  {
                    id,
                    name: t("llm.newModel"),
                    model: "",
                    provider: "openai-compatible",
                    protocol: "litellm-chat",
                    apiBaseUrl: "",
                    secretRef: null,
                    enabled: false,
                    descriptors: structuredClone(basicDescriptors),
                    settings: {},
                  },
                ],
              });
            }}
          >
            {t("llm.addModel")}
          </Button>
          <label className="field">
            {t("llm.importProfiles")}
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => {
                void importProfiles(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
        </Space>
        {draft.models.map((model) => (
          <details key={model.id} open className="llm-connection">
            <summary>
              {model.name} · <code>{model.id}</code>
            </summary>
            <Space
              orientation="vertical"
              size="middle"
              className="skills-full-width"
            >
              <ModelText
                label={t("llm.name")}
                model={model}
                field="name"
                disabled={busy}
                onChange={updateModel}
              />
              <ModelText
                label={t("llm.model")}
                model={model}
                field="model"
                disabled={busy}
                onChange={updateModel}
              />
              <label className="field">
                {t("llm.provider")}
                <Select
                  aria-label={`${t("llm.provider")} · ${model.id}`}
                  disabled={busy}
                  value={model.provider}
                  options={[
                    { value: "deepseek", label: "DeepSeek" },
                    { value: "openai-compatible", label: "OpenAI compatible" },
                  ]}
                  onChange={(provider) => updateModel(model.id, { provider })}
                />
              </label>
              <label className="field">
                {t("llm.protocol")}
                <Select
                  aria-label={`${t("llm.protocol")} · ${model.id}`}
                  disabled={busy}
                  value={model.protocol}
                  options={[
                    {
                      value: "litellm-chat",
                      label: "LiteLLM Chat Completions",
                    },
                    {
                      value: "openai-chat",
                      label: "OpenAI compatible Chat Completions",
                    },
                  ]}
                  onChange={(protocol) => updateModel(model.id, { protocol })}
                />
              </label>
              <ModelText
                label={t("llm.apiBase")}
                model={model}
                field="apiBaseUrl"
                disabled={busy}
                onChange={updateModel}
              />
              <label className="field">
                {t("llm.enabled")}
                <Switch
                  aria-label={`${t("llm.enabled")} · ${model.id}`}
                  disabled={busy}
                  checked={model.enabled}
                  onChange={(enabled) => updateModel(model.id, { enabled })}
                />
              </label>
              <Space wrap>
                <span>{t("llm.apiKey")}</span>
                <Tag>
                  {saved.credentials[model.id]?.configured
                    ? t("llm.keyConfigured")
                    : t("llm.keyMissing")}
                </Tag>
              </Space>
              {saved.credentials[model.id]?.configured && (
                <>
                  <Select
                    aria-label={`${t("llm.keyAction")} · ${model.id}`}
                    disabled={busy}
                    value={secrets[model.id]?.action ?? "preserve"}
                    options={[
                      { value: "preserve", label: t("llm.preserveKey") },
                      { value: "replace", label: t("llm.replaceKey") },
                      { value: "clear", label: t("llm.clearKey") },
                    ]}
                    onChange={(action: "preserve" | "replace" | "clear") =>
                      setSecrets((current) => {
                        const next = { ...current };
                        if (action === "preserve") delete next[model.id];
                        else
                          next[model.id] =
                            action === "clear"
                              ? { action: "clear" }
                              : { action: "replace", value: "" };
                        return next;
                      })
                    }
                  />
                  <p className="muted">{t("llm.preserveKeyHelp")}</p>
                </>
              )}
              {(!saved.credentials[model.id]?.configured ||
                secrets[model.id]?.action === "replace") && (
                <label className="field">
                  {t(
                    saved.credentials[model.id]?.configured
                      ? "llm.replacementKey"
                      : "llm.apiKey",
                  )}
                  <Input.Password
                    aria-label={`${t(saved.credentials[model.id]?.configured ? "llm.replacementKey" : "llm.apiKey")} · ${model.id}`}
                    disabled={busy || !saved.secretStorageConfigured}
                    autoComplete="new-password"
                    value={
                      secrets[model.id]?.action === "replace"
                        ? (secrets[model.id] as { value: string }).value
                        : ""
                    }
                    onChange={(event) =>
                      setSecrets((current) => {
                        const next = { ...current };
                        if (
                          !event.target.value &&
                          !saved.credentials[model.id]?.configured
                        )
                          delete next[model.id];
                        else
                          next[model.id] = {
                            action: "replace",
                            value: event.target.value,
                          };
                        return next;
                      })
                    }
                  />
                </label>
              )}
              {(!saved.credentials[model.id]?.configured ||
                secrets[model.id]?.action === "replace") && (
                <p className="muted">{t("llm.keyEntryHelp")}</p>
              )}
              {!saved.secretStorageConfigured && (
                <p className="muted">{t("llm.externalSecretHelp")}</p>
              )}
              <details>
                <summary>{t("llm.advancedCredentials")}</summary>
                <p>{t("llm.secretRefHelp")}</p>
                <label className="field">
                  {t("llm.secretRef")}
                  <Input
                    aria-label={`${t("llm.secretRef")} · ${model.id}`}
                    disabled={busy}
                    value={model.secretRef ?? ""}
                    onChange={(event) =>
                      updateModel(model.id, {
                        secretRef: event.target.value || null,
                      })
                    }
                    autoComplete="off"
                  />
                </label>
              </details>
              <h3>{t("llm.settings")}</h3>
              <p className="muted">{t("llm.contextHelp")}</p>
              {model.descriptors.map((descriptor) => {
                const value =
                  model.settings[descriptor.key] ?? descriptor.default;
                const change = (value: SettingValue) =>
                  updateModel(model.id, {
                    settings: { ...model.settings, [descriptor.key]: value },
                  });
                return (
                  <label className="field" key={descriptor.key}>
                    {descriptor.label}
                    {descriptor.type === "boolean" ? (
                      <Switch
                        aria-label={`${descriptor.label} · ${model.id}`}
                        disabled={busy}
                        checked={Boolean(value)}
                        onChange={change}
                      />
                    ) : descriptor.type === "enum" ? (
                      <Select
                        aria-label={`${descriptor.label} · ${model.id}`}
                        disabled={busy}
                        value={JSON.stringify(value)}
                        options={descriptor.options?.map((option) => ({
                          value: JSON.stringify(option.value),
                          label: option.label,
                        }))}
                        onChange={(value: string) =>
                          change(JSON.parse(value) as SettingValue)
                        }
                      />
                    ) : (
                      <InputNumber
                        aria-label={`${descriptor.label} · ${model.id}`}
                        disabled={busy}
                        min={descriptor.minimum}
                        max={descriptor.maximum}
                        precision={
                          descriptor.type === "integer" ? 0 : undefined
                        }
                        value={value as number}
                        onChange={(value) => {
                          if (value !== null) change(value);
                        }}
                      />
                    )}
                  </label>
                );
              })}
              <DescriptorEditor
                model={model}
                disabled={busy}
                onChange={(descriptors) =>
                  updateModel(model.id, { descriptors })
                }
              />
              {dirty && <p role="status">{t("llm.saveBeforeTest")}</p>}
              <Button
                aria-label={t("llm.testConnection")}
                disabled={busy || dirty}
                loading={testing === model.id}
                onClick={() => void testConnection(model.id)}
              >
                {t("llm.testConnection")}
              </Button>
              {connectionNotices[model.id] && (
                <div
                  ref={(node) => {
                    if (node) feedback.current.set(model.id, node);
                    else feedback.current.delete(model.id);
                  }}
                >
                  <Alert
                    showIcon
                    type={connectionNotices[model.id].type}
                    title={connectionNotices[model.id].message}
                  />
                </div>
              )}
              <p className="muted">{t("llm.testHelp")}</p>
            </Space>
          </details>
        ))}
      </section>
      <section className="skills-full-width">
        <h2>{t("llm.assignments")}</h2>
        {Object.entries(draft.bindings).map(([id, binding]) => (
          <label className="field" key={id}>
            {id === "script-side-effects" ? t("llm.scriptFunction") : id}
            <Select
              aria-label={`${t("llm.assignedModel")} · ${id}`}
              allowClear
              value={binding ?? undefined}
              options={draft.models.map((m) => ({
                value: m.id,
                label: `${m.name} · ${m.id}`,
              }))}
              onChange={(value: string | undefined) =>
                setDraft({
                  ...draft,
                  bindings: { ...draft.bindings, [id]: value ?? null },
                })
              }
            />
          </label>
        ))}
      </section>
      <section className="skills-full-width">
        <h2>{t("llm.prompts")}</h2>
        <p>{t("llm.promptHelp")}</p>
        {Object.entries(draft.prompts).map(([id, prompt]) => (
          <div key={id} className="llm-connection">
            <h3>{id}</h3>
            <p>{prompt.description}</p>
            <label className="field">
              {t("llm.promptText")}
              <Input.TextArea
                aria-label={`${t("llm.promptText")} · ${id}`}
                rows={10}
                disabled={busy}
                value={prompt.text}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    prompts: {
                      ...draft.prompts,
                      [id]: { ...prompt, text: event.target.value },
                    },
                  })
                }
              />
            </label>
          </div>
        ))}
      </section>
      <div
        role="region"
        aria-label={t("llm.actions")}
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 2,
          padding: 16,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorder}`,
          borderRadius: token.borderRadius,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <span role="status">{t(dirty ? "llm.unsaved" : "llm.allSaved")}</span>
        {error && <Alert type="error" showIcon title={error} />}
        {notice && <Alert type="success" showIcon title={notice} />}
        <Space wrap>
          <Button
            type="primary"
            aria-label={t("llm.save")}
            disabled={busy}
            loading={busy && testing === null}
            onClick={() =>
              void perform(async () => {
                accept(await saveLlm(basePath, saved.revision, draft, secrets));
                setNotice(t("llm.saved"));
              })
            }
          >
            {t("llm.save")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => accept(await loadLlm(basePath)))
            }
          >
            {t("llm.reload")}
          </Button>
          <Button disabled={busy} onClick={exportConfiguration}>
            {t("llm.export")}
          </Button>
          {saved.fileConfigured && (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  accept(await reloadLlm(basePath, saved.revision));
                  setNotice(t("llm.saved"));
                })
              }
            >
              {t("llm.reloadFile")}
            </Button>
          )}
        </Space>
      </div>
    </div>
  );
}

function ModelText({
  label,
  model,
  field,
  disabled,
  onChange,
}: {
  label: string;
  model: ModelConnection;
  field: "name" | "model" | "apiBaseUrl";
  disabled: boolean;
  onChange(id: string, patch: Partial<ModelConnection>): void;
}) {
  return (
    <label className="field">
      {label}
      <Input
        aria-label={`${label} · ${model.id}`}
        disabled={disabled}
        value={model[field]}
        onChange={(event) =>
          onChange(model.id, { [field]: event.target.value })
        }
        autoComplete="off"
      />
    </label>
  );
}
function DescriptorEditor({
  model,
  disabled,
  onChange,
}: {
  model: ModelConnection;
  disabled: boolean;
  onChange(value: ModelSetting[]): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(JSON.stringify(model.descriptors, null, 2));
  const [error, setError] = useState(false);
  useEffect(
    () => setText(JSON.stringify(model.descriptors, null, 2)),
    [model.descriptors],
  );
  return (
    <details>
      <summary>{t("llm.descriptors")}</summary>
      <p>{t("llm.descriptorsHelp")}</p>
      <Input.TextArea
        aria-label={`${t("llm.descriptors")} · ${model.id}`}
        rows={12}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        disabled={disabled}
        onClick={() => {
          try {
            const value = JSON.parse(text);
            if (!Array.isArray(value) || !value.every(renderableDescriptor))
              throw new Error();
            onChange(value);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {t("llm.applyDescriptors")}
      </Button>
      {error && <Alert type="error" title={t("llm.importFailed")} />}
    </details>
  );
}

// Check imported JSON is safe to render; the server owns full configuration validation.
function renderableModel(value: unknown): value is ModelConnection {
  if (!isRecord(value)) return false;
  return (
    ["id", "name", "model", "apiBaseUrl", "provider", "protocol"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.enabled === "boolean" &&
    (value.secretRef === null || typeof value.secretRef === "string") &&
    isRecord(value.settings) &&
    Array.isArray(value.descriptors) &&
    value.descriptors.every(renderableDescriptor)
  );
}
function renderableDescriptor(value: unknown): value is ModelSetting {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    ["boolean", "integer", "number", "enum"].includes(String(value.type)) &&
    ["string", "number", "boolean"].includes(typeof value.default) &&
    isRecord(value.mapping) &&
    typeof value.mapping.target === "string" &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.every(
          (option) =>
            isRecord(option) &&
            typeof option.label === "string" &&
            ["string", "number", "boolean"].includes(typeof option.value),
        )))
  );
}
