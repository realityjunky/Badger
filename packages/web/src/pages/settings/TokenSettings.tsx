import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import {
  createToken,
  loadTokens,
  revokeToken,
  type PersonalAccessToken,
  type TokenScope,
} from "../../api/tokens.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { McpSetup } from "./McpSetup.js";

interface TokenForm {
  name: string;
  scopes: TokenScope[];
  days: number;
}

export function TokenSettings() {
  const { t, format, locale } = useI18n();
  const basePath = readBasePath(document);
  const [tokens, setTokens] = useState<PersonalAccessToken[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [created, setCreated] = useState<{ secret: string } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [failure, setFailure] = useState<
    "conflict" | "failed" | "denied" | null
  >(null);
  const [form] = Form.useForm<TokenForm>();
  const reload = () => setRefresh((value) => value + 1);
  const scopeNames = {
    engineer: t("tokens.scope.engineer"),
    expert: t("tokens.scope.expert"),
    operator: t("tokens.scope.operator"),
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    setTokens(null);
    setFailure(null);
    void loadTokens(basePath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setTokens(result.value.tokens);
      else setLoadFailed(true);
    });
    return () => controller.abort();
  }, [basePath, refresh]);

  const submit = async (values: TokenForm) => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const result = await createToken(basePath, {
      name: values.name.trim(),
      scopes: values.scopes,
      ...(values.days === 90
        ? {}
        : {
            expiresAt: new Date(
              Date.now() + values.days * 24 * 60 * 60 * 1000,
            ).toISOString(),
          }),
    });
    setSaving(false);
    if (result.kind !== "ok") {
      setFailure(result.kind);
      return;
    }
    setTokens((current) => [result.value.token, ...(current ?? [])]);
    setCreating(false);
    setCopyState("idle");
    setCreated({ secret: result.value.secret });
  };

  const revoke = async (token: PersonalAccessToken) => {
    if (revoking !== null) return;
    setRevoking(token.id);
    setFailure(null);
    const result = await revokeToken(basePath, token);
    setRevoking(null);
    if (result.kind !== "ok") {
      setFailure(result.kind);
      return;
    }
    setTokens(
      (current) =>
        current?.map((entry) =>
          entry.id === token.id ? result.value.token : entry,
        ) ?? null,
    );
  };

  const notice =
    failure === null ? null : (
      <Alert
        showIcon
        type="error"
        title={t(
          failure === "conflict" ? "tokens.conflict" : "tokens.writeFailed",
        )}
        action={<Button onClick={reload}>{t("common.retry")}</Button>}
      />
    );

  return (
    <section className="settings-panel">
      <p className="muted">{t("settings.tokens.description")}</p>
      <p className="muted">{t("tokens.permissions")}</p>
      <McpSetup />
      <div>
        <Button
          type="primary"
          disabled={tokens === null || revoking !== null}
          onClick={() => {
            form.resetFields();
            setFailure(null);
            setCreating(true);
          }}
        >
          {t("tokens.create")}
        </Button>
      </div>
      {tokens === null && !loadFailed && (
        <p role="status">{t("common.loading")}</p>
      )}
      {loadFailed && (
        <Alert
          showIcon
          type="error"
          title={t("tokens.loadFailed")}
          action={<Button onClick={reload}>{t("common.retry")}</Button>}
        />
      )}
      {!creating && notice}
      {tokens?.length === 0 && (
        <p className="empty-state">{t("tokens.empty")}</p>
      )}
      <ul className="personal-tokens">
        {tokens?.map((token) => {
          const status =
            token.revokedAt !== null
              ? "revoked"
              : Date.parse(token.expiresAt) <= Date.now()
                ? "expired"
                : "active";
          return (
            <li key={token.id}>
              <article className="personal-token" aria-label={token.name}>
                <div className="personal-token-heading">
                  <h3>{token.name}</h3>
                  <Tag>
                    {t(
                      status === "revoked"
                        ? "tokens.revoked"
                        : status === "expired"
                          ? "tokens.expired"
                          : "tokens.active",
                    )}
                  </Tag>
                </div>
                <code>{token.prefix}</code>
                <Space wrap>
                  {token.scopes.map((scope) => (
                    <Tag key={scope}>{scopeNames[scope]}</Tag>
                  ))}
                </Space>
                <dl className="personal-token-details">
                  <div>
                    <dt>{t("tokens.created")}</dt>
                    <dd>{new Date(token.createdAt).toLocaleString(locale)}</dd>
                  </div>
                  <div>
                    <dt>{t("tokens.expires")}</dt>
                    <dd>{new Date(token.expiresAt).toLocaleString(locale)}</dd>
                  </div>
                  <div>
                    <dt>{t("tokens.lastUsed")}</dt>
                    <dd>
                      {token.lastUsedAt === null
                        ? t("tokens.neverUsed")
                        : new Date(token.lastUsedAt).toLocaleString(locale)}
                    </dd>
                  </div>
                  {token.lastUsedChannel !== null && (
                    <div>
                      <dt>{t("tokens.channel")}</dt>
                      <dd>{t("tokens.channel.mcp")}</dd>
                    </div>
                  )}
                </dl>
                <div>
                  <Popconfirm
                    title={t("tokens.revokeConfirm")}
                    description={t("tokens.revokeHint")}
                    okText={t("tokens.revokeAction")}
                    cancelText={t("workflow.cancel")}
                    onConfirm={() => revoke(token)}
                    disabled={token.revokedAt !== null || revoking !== null}
                  >
                    <Button
                      danger
                      disabled={token.revokedAt !== null || revoking !== null}
                      loading={revoking === token.id}
                    >
                      {t("tokens.revoke")}
                    </Button>
                  </Popconfirm>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {creating && (
        <Modal
          open
          title={t("tokens.create")}
          okText={t("tokens.create")}
          cancelText={t("workflow.cancel")}
          onOk={() => form.submit()}
          onCancel={() => setCreating(false)}
          confirmLoading={saving}
          closable={!saving}
          maskClosable={!saving}
          cancelButtonProps={{ disabled: saving }}
        >
          {notice}
          <Form
            form={form}
            name="personal-token"
            layout="vertical"
            disabled={saving}
            onFinish={(values) => void submit(values)}
            initialValues={{ scopes: [], days: 90 }}
          >
            <Form.Item
              name="name"
              label={t("tokens.name")}
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: t("tokens.required"),
                },
              ]}
            >
              <Input maxLength={120} autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="scopes"
              label={t("tokens.scopes")}
              extra={t("tokens.permissions")}
              rules={[
                {
                  required: true,
                  type: "array",
                  min: 1,
                  message: t("tokens.chooseScope"),
                },
              ]}
            >
              <Checkbox.Group
                options={Object.entries(scopeNames).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
            <Form.Item name="days" label={t("tokens.expiration")}>
              <Select
                options={[7, 30, 90].map((days) => ({
                  value: days,
                  label: format("tokens.days", { days }),
                }))}
              />
            </Form.Item>
          </Form>
        </Modal>
      )}
      {created !== null && (
        <Modal
          open
          title={t("tokens.createdTitle")}
          closable={false}
          maskClosable={false}
          keyboard={false}
          footer={
            <Button type="primary" onClick={() => setCreated(null)}>
              {t("tokens.saved")}
            </Button>
          }
        >
          <Alert showIcon type="warning" title={t("tokens.showOnce")} />
          <div className="personal-token-secret">
            <label htmlFor="token-secret">{t("tokens.secret")}</label>
            <Input.TextArea
              id="token-secret"
              readOnly
              value={created.secret}
              autoComplete="off"
              spellCheck={false}
              rows={3}
            />
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.secret);
                  setCopyState("copied");
                } catch {
                  setCopyState("failed");
                }
              }}
            >
              {t("tokens.copy")}
            </Button>
            {copyState !== "idle" && (
              <p role="status">
                {t(
                  copyState === "copied"
                    ? "tokens.copied"
                    : "tokens.copyFailed",
                )}
              </p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
