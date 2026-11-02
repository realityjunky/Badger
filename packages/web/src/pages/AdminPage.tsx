import {
  Alert,
  Button,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  createGroup,
  inviteByEmail,
  ledGroupIds,
  loadOrganization,
  mayChangeBinding,
  removeBinding,
  resendInvitation,
  type Group,
  type Invitation,
  type Member,
  type OrganizationRecords,
  type WriteOutcome,
  type ScopeType,
} from "../api/organization.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";
import { usePreferences } from "../preferences/PreferencesContext.js";

const TABS = [
  "members",
  "groups",
  "invitations",
  "integrations",
  "tokens",
] as const;
type TabKey = (typeof TABS)[number];

function isTab(value: string | undefined): value is TabKey {
  return TABS.includes(value as TabKey);
}

type State =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "failed" }
  | { kind: "ready"; records: OrganizationRecords };

const ORGANIZATION_ROLES = ["Administrator", "Auditor"];
const GROUP_ROLES = ["Group lead", "Member"];

/** Members, groups, and pending invitations, each on its own URL. */
export function AdminPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const basePath = readBasePath(document);
  const segment = location.pathname.split("/")[2];
  const active: TabKey = isTab(segment) ? segment : "members";

  // The server enforces every rule; these only keep controls the person may
  // not use out of the way.
  const { person } = usePreferences();
  const administrator = person?.roles.includes("Administrator") ?? false;
  const groupLead =
    person?.groups.some((group) => group.role === "Group lead") ?? false;
  const mayManage = administrator || groupLead;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "warning">(
    "warning",
  );
  const [sendingInvitation, setSendingInvitation] = useState<string | null>(
    null,
  );

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await loadOrganization(basePath, signal);
      if (signal?.aborted === true) {
        return;
      }
      if (loaded.kind === "ok") {
        setState({ kind: "ready", records: loaded.value });
      } else {
        setState({ kind: loaded.kind });
      }
    },
    [basePath],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const groups = state.kind === "ready" ? state.records.groups : null;
  const led = useMemo(
    () => ledGroupIds(person?.groups ?? [], groups ?? []),
    [person, groups],
  );
  const mayChange = (binding: {
    scopeType: ScopeType;
    scopeId: string | null;
  }): boolean => mayChangeBinding(binding, administrator, led);

  const groupNames = useMemo(() => {
    const names = new Map<string, string>();
    if (state.kind === "ready") {
      for (const group of state.records.groups) {
        names.set(group.id, group.name);
      }
    }
    return names;
  }, [state]);

  // A "rejected" write is left to the form that made it: only an invitation
  // can be refused that way, and its panel asks for an override reason.
  const reportWrite = useCallback(
    async (
      written: WriteOutcome | Promise<WriteOutcome>,
    ): Promise<WriteOutcome> => {
      const result = await written;
      if (result.kind === "ok") {
        const status = result.invitationDelivery?.status;
        setNotice(status ? t(`admin.invite.delivery.${status}`) : null);
        setNoticeType(status === "sent" ? "success" : "warning");
        await reload();
      } else if (result.kind !== "rejected") {
        setNoticeType("warning");
        setNotice(
          result.kind === "denied" ? t("admin.denied") : t("admin.writeFailed"),
        );
      }
      return result;
    },
    [reload, t],
  );

  const resend = async (invitation: {
    id: string;
    revision: number;
  }): Promise<void> => {
    if (sendingInvitation !== null) return;
    setSendingInvitation(invitation.id);
    try {
      await reportWrite(
        resendInvitation(basePath, invitation.id, invitation.revision),
      );
    } finally {
      setSendingInvitation(null);
    }
  };

  const memberColumns: TableColumnsType<Member> = [
    {
      title: t("admin.members.name"),
      key: "name",
      render: (_, member) => member.person.displayName,
    },
    {
      title: t("admin.members.email"),
      key: "email",
      render: (_, member) => member.person.email,
    },
    {
      title: t("admin.members.roles"),
      key: "roles",
      render: (_, member) => (
        <Space size={[4, 4]} wrap>
          {[
            ...member.organizationRoles,
            ...member.groups.map((group) => `${group.role} · ${group.name}`),
            ...member.bindings
              .filter((binding) => binding.scopeType === "workflow")
              .map(
                (binding) =>
                  `${binding.role} · ${binding.scopeName ?? binding.scopeId}`,
              ),
          ].map((role) => (
            <Tag key={role}>{role}</Tag>
          ))}
        </Space>
      ),
    },
    ...(mayManage
      ? [
          {
            title: "",
            key: "actions",
            render: (_: unknown, member: Member) => (
              <Space size={4} wrap>
                {member.bindings.find(mayChange) && (
                  <Button
                    size="small"
                    disabled={sendingInvitation !== null}
                    onClick={() =>
                      void resend(member.bindings.find(mayChange)!)
                    }
                  >
                    {t("admin.invite.resend")}
                  </Button>
                )}
                {member.bindings.filter(mayChange).map((binding) => (
                  <Popconfirm
                    key={binding.id}
                    title={t("admin.removeBindingConfirm")}
                    onConfirm={() =>
                      void reportWrite(
                        removeBinding(basePath, binding.id, binding.revision),
                      )
                    }
                  >
                    <Button size="small" danger>
                      {binding.role}
                    </Button>
                  </Popconfirm>
                ))}
              </Space>
            ),
          },
        ]
      : []),
  ];

  const groupColumns: TableColumnsType<Group> = [
    { title: t("admin.groups.name"), dataIndex: "name", key: "name" },
    {
      title: t("admin.groups.parent"),
      key: "parent",
      render: (_, group) =>
        group.parentId === null
          ? t("admin.groups.topLevel")
          : (groupNames.get(group.parentId) ?? group.parentId),
    },
  ];

  const invitationColumns: TableColumnsType<Invitation> = [
    {
      title: t("admin.invitations.email"),
      dataIndex: "email",
      key: "email",
    },
    { title: t("admin.invitations.role"), dataIndex: "role", key: "role" },
    {
      title: t("admin.invitations.scope"),
      key: "scope",
      render: (_, invitation) =>
        invitation.scopeType === "organization"
          ? t("admin.invite.scopeOrganization")
          : (invitation.scopeName ?? invitation.scopeId ?? ""),
    },
    {
      title: t("admin.invitations.invitedBy"),
      dataIndex: "invitedByName",
      key: "invitedBy",
    },
    ...(mayManage
      ? [
          {
            title: "",
            key: "actions",
            render: (_: unknown, invitation: Invitation) =>
              mayChange(invitation) ? (
                <Space>
                  <Button
                    size="small"
                    disabled={sendingInvitation !== null}
                    loading={sendingInvitation === invitation.id}
                    onClick={() => void resend(invitation)}
                  >
                    {t("admin.invite.resend")}
                  </Button>
                  <Popconfirm
                    title={t("admin.removeConfirm")}
                    onConfirm={() =>
                      void reportWrite(
                        removeBinding(
                          basePath,
                          invitation.id,
                          invitation.revision,
                        ),
                      )
                    }
                  >
                    <Button size="small" danger>
                      {t("admin.remove")}
                    </Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]
      : []),
  ];

  const placeholder = <p className="empty-state">{t("page.placeholder")}</p>;

  return (
    <div className="page" data-testid="page-admin">
      <PageHeader
        title={t("page.admin.title")}
        description={t("page.admin.description")}
      />
      {notice !== null && (
        <Alert
          type={noticeType}
          showIcon
          closable
          message={notice}
          onClose={() => setNotice(null)}
          style={{ marginBottom: 16 }}
        />
      )}
      {state.kind === "loading" && (
        <p className="muted">{t("common.loading")}</p>
      )}
      {state.kind === "denied" && (
        <p className="empty-state" data-testid="admin-denied">
          {t("admin.denied")}
        </p>
      )}
      {state.kind === "failed" && (
        <Alert type="error" showIcon message={t("admin.failed")} />
      )}
      {state.kind === "ready" && (
        <Tabs
          className="underline-tabs"
          activeKey={active}
          onChange={(key) => navigate(`/admin/${key}`)}
          items={[
            {
              key: "members",
              label: t("admin.tab.members"),
              children: (
                <Table<Member>
                  rowKey={(member) => member.person.id}
                  dataSource={state.records.members}
                  columns={memberColumns}
                  pagination={false}
                  size="small"
                />
              ),
            },
            {
              key: "groups",
              label: t("admin.tab.groups"),
              children: (
                <GroupPanel
                  groups={state.records.groups}
                  groupNames={groupNames}
                  columns={groupColumns}
                  canCreate={administrator}
                  onCreate={async (name, parentId) => {
                    await reportWrite(createGroup(basePath, name, parentId));
                  }}
                />
              ),
            },
            {
              key: "invitations",
              label: t("admin.tab.invitations"),
              children: (
                <Space
                  direction="vertical"
                  size="large"
                  style={{ width: "100%" }}
                >
                  {mayManage && (
                    <InvitePanel
                      groups={
                        administrator
                          ? state.records.groups
                          : state.records.groups.filter((group) =>
                              led.has(group.id),
                            )
                      }
                      administrator={administrator}
                      onInvite={(input) =>
                        reportWrite(inviteByEmail(basePath, input))
                      }
                    />
                  )}
                  {state.records.invitations.length === 0 ? (
                    <p className="empty-state">{t("admin.invitations.none")}</p>
                  ) : (
                    <Table<Invitation>
                      rowKey="id"
                      dataSource={state.records.invitations}
                      columns={invitationColumns}
                      pagination={false}
                      size="small"
                    />
                  )}
                </Space>
              ),
            },
            {
              key: "integrations",
              label: t("admin.tab.integrations"),
              children: placeholder,
            },
            {
              key: "tokens",
              label: t("admin.tab.tokens"),
              children: placeholder,
            },
          ]}
        />
      )}
    </div>
  );
}

function GroupPanel({
  groups,
  groupNames,
  columns,
  canCreate,
  onCreate,
}: {
  groups: Group[];
  groupNames: Map<string, string>;
  columns: TableColumnsType<Group>;
  canCreate: boolean;
  onCreate(name: string, parentId: string | null): Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (name.trim() === "" || busy) {
      return;
    }
    setBusy(true);
    try {
      await onCreate(name.trim(), parentId);
      setName("");
      setParentId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {canCreate && (
        <Space wrap>
          <Input
            aria-label={t("admin.groups.name")}
            placeholder={t("admin.groups.namePlaceholder")}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label={t("admin.groups.parent")}
            style={{ minWidth: 180 }}
            value={parentId}
            allowClear
            placeholder={t("admin.groups.topLevel")}
            onChange={(value) => setParentId(value ?? null)}
            options={groups.map((group) => ({
              value: group.id,
              label: groupNames.get(group.id) ?? group.name,
            }))}
          />
          <Button type="primary" onClick={() => void submit()} loading={busy}>
            {t("admin.groups.create")}
          </Button>
        </Space>
      )}
      {groups.length === 0 ? (
        <p className="empty-state">{t("admin.groups.none")}</p>
      ) : (
        <Table<Group>
          rowKey="id"
          dataSource={groups}
          columns={columns}
          pagination={false}
          size="small"
        />
      )}
    </Space>
  );
}

function InvitePanel({
  groups,
  administrator,
  onInvite,
}: {
  groups: Group[];
  administrator: boolean;
  onInvite(input: {
    email: string;
    role: string;
    scopeType: "organization" | "group";
    scopeId: string | null;
    overrideReason?: string;
  }): Promise<WriteOutcome>;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [scopeType, setScopeType] = useState<"organization" | "group">(
    administrator ? "organization" : "group",
  );
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [role, setRole] = useState(
    administrator
      ? (ORGANIZATION_ROLES[0] ?? "Administrator")
      : (GROUP_ROLES[1] ?? "Member"),
  );
  const [busy, setBusy] = useState(false);
  // Set once the server refuses a self-grant: the same invitation may then be
  // sent again with a recorded reason.
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");

  const roles = scopeType === "organization" ? ORGANIZATION_ROLES : GROUP_ROLES;
  const ready =
    email.trim() !== "" &&
    (scopeType === "organization" || scopeId !== null) &&
    roles.includes(role);

  const submit = async (overrideReason?: string): Promise<void> => {
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    try {
      const outcome = await onInvite({
        email: email.trim(),
        role,
        scopeType,
        scopeId: scopeType === "organization" ? null : scopeId,
        ...(overrideReason === undefined ? {} : { overrideReason }),
      });
      if (outcome.kind === "rejected") {
        setOverriding(true);
        return;
      }
      if (outcome.kind === "ok") {
        setEmail("");
        setOverriding(false);
        setReason("");
      }
    } finally {
      setBusy(false);
    }
  };

  // Any change to the invitation makes it a new request, with no override.
  const edited = (): void => {
    setOverriding(false);
    setReason("");
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap align="start">
        <Input
          aria-label={t("admin.invite.email")}
          placeholder={t("admin.invite.emailPlaceholder")}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            edited();
          }}
          onPressEnter={() => void submit()}
        />
        {administrator && (
          <Select
            aria-label={t("admin.invite.scope")}
            value={scopeType}
            style={{ minWidth: 150 }}
            onChange={(value: "organization" | "group") => {
              edited();
              setScopeType(value);
              setScopeId(null);
              setRole(
                value === "organization"
                  ? ORGANIZATION_ROLES[0]
                  : GROUP_ROLES[1],
              );
            }}
            options={[
              {
                value: "organization",
                label: t("admin.invite.scopeOrganization"),
              },
              { value: "group", label: t("admin.invite.scopeGroup") },
            ]}
          />
        )}
        {scopeType === "group" && (
          <Select
            aria-label={t("admin.invite.group")}
            style={{ minWidth: 180 }}
            value={scopeId}
            placeholder={t("admin.invite.groupPlaceholder")}
            onChange={(value: string) => {
              edited();
              setScopeId(value);
            }}
            options={groups.map((group) => ({
              value: group.id,
              label: group.name,
            }))}
          />
        )}
        <Select
          aria-label={t("admin.invite.role")}
          value={role}
          style={{ minWidth: 150 }}
          onChange={(value: string) => {
            edited();
            setRole(value);
          }}
          options={roles.map((name) => ({ value: name, label: name }))}
        />
        <Button type="primary" onClick={() => void submit()} loading={busy}>
          {t("admin.invite.submit")}
        </Button>
      </Space>
      {overriding && (
        <Alert
          type="warning"
          showIcon
          data-testid="admin-override"
          message={t("admin.invite.overrideNeeded")}
          description={
            administrator ? (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input.TextArea
                  aria-label={t("admin.invite.overrideReason")}
                  value={reason}
                  maxLength={1000}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button
                  danger
                  disabled={reason.trim() === ""}
                  loading={busy}
                  onClick={() => void submit(reason.trim())}
                >
                  {t("admin.invite.overrideSubmit")}
                </Button>
              </Space>
            ) : null
          }
        />
      )}
    </Space>
  );
}
