import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { useCallback, useEffect, useId, useState } from "react";
import type {
  AuthoringLaneFinding,
  FindingDisposition,
  FindingRoute,
} from "@realityjunky/badger";
import { Link, useLocation } from "react-router-dom";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { previewUpload, uploadVersion } from "../../api/skills.js";
import { AgentPromptButton } from "../../components/AgentPromptButton.js";
import { useI18n } from "../../i18n/I18nContext.js";

const translations = {
  en: {
    observations: "Lane observations",
    findings: "Findings",
    writerFindings: "Findings from this writer job",
    allFindings: "Show all package findings",
    mapBehavior: "Open executable behavior",
    mappedPlan: "Edit workflow map",
    work: "Dispatched work",
    empty: "No findings have been reported.",
    group: "Review grouping",
    draft: "Draft dispositions",
    subject: "Finding",
    target: "Target",
    authority: "Governing requirement or citation",
    acceptance: "What should pass?",
    route: "Next action",
    due: "Evidence required before",
    dependency: "Wait for evidence from",
    signed: "Use a signed checker receipt",
    node: "Checker Node ID",
    requirement: "Verification requirement ID",
    replace: "Use individual finding assignments",
    repair: "Earlier Plan repair",
    save: "Save finding",
    dispatch: "Dispatch ready work",
    verify: "Verify adopted changes",
    review: "Review result",
    adopt: "Accept result",
    confirm: "Confirm",
    cancel: "Cancel",
    reason: "Reason",
    dismiss: "No longer applicable",
    reopen: "Reopen",
    refresh: "Refresh",
    link: "Link to an existing finding",
    new: "Create a finding",
    choose: "Select observations to group, or findings to dispatch.",
    back: "Send back",
    details: "Evidence",
    plan: "Edit Plan",
    implementation: "Implement package change",
    verification: "Verify package",
    lane: "Revise lane",
    question: "Ask an expert",
    sources: "Review Sources",
    dossier: "Review Dossier",
    proposal: "Review Proposal",
    badger: "Report Badger defect",
    stage: "Open related stage",
    history: "Earlier submission",
    pending: "Awaiting regeneration",
    suggested: "Suggested",
    open: "Open",
    "awaiting-evidence": "Awaiting evidence",
    verified: "Verified",
    recheck: "Recheck required",
    "not-applicable": "No longer applicable",
    noFiles: "Waiting for evidence",
    resolved: "Reviewed program fingerprint",
    labels: "Source observations",
    skill: "Package source",
    local: "Package implementation files",
    adoptSource: "Adopt Skill version",
  },
  zh: {
    observations: "分道观察",
    findings: "待解决问题",
    writerFindings: "本次编写任务的问题",
    allFindings: "查看工作流包的全部问题",
    mapBehavior: "打开执行规则",
    mappedPlan: "编辑工作流映射",
    work: "已派发工作",
    empty: "尚无问题报告。",
    group: "审核分组",
    draft: "起草处理建议",
    subject: "问题",
    target: "目标",
    authority: "依据或引用",
    acceptance: "验收条件",
    route: "下一步",
    due: "证据期限",
    dependency: "依赖的问题",
    signed: "使用签名的检查回执",
    node: "检查节点 ID",
    requirement: "验证要求 ID",
    replace: "改为按问题派发",
    repair: "先前的计划修复",
    save: "保存问题",
    dispatch: "派发已就绪工作",
    verify: "验证已采纳的变更",
    review: "审核结果",
    adopt: "接受结果",
    confirm: "确认",
    cancel: "取消",
    reason: "原因",
    dismiss: "不再适用",
    reopen: "重新打开",
    refresh: "刷新",
    link: "关联已有问题",
    new: "创建问题",
    choose: "选择要分组的观察或要派发的问题。",
    back: "退回修改",
    details: "证据",
    plan: "修改计划",
    implementation: "实现软件包变更",
    verification: "验证软件包",
    lane: "修改分道结果",
    question: "咨询专家",
    sources: "审核来源",
    dossier: "审核档案",
    proposal: "审核提案",
    badger: "报告 Badger 缺陷",
    stage: "打开相关阶段",
    history: "较早的提交",
    pending: "等待重新生成",
    suggested: "建议",
    open: "待处理",
    "awaiting-evidence": "待补证据",
    verified: "已验证",
    recheck: "需重新验证",
    "not-applicable": "不再适用",
    noFiles: "等待证据",
    resolved: "已审核的程序指纹",
    labels: "来源观察",
    skill: "软件包来源",
    local: "软件包实现文件",
    adoptSource: "采用技能版本",
  },
};
type Status =
  | "suggested"
  | "open"
  | "awaiting-evidence"
  | "verified"
  | "recheck"
  | "not-applicable";
type Finding = {
  id: string;
  problem: string;
  status: Status;
  subjectHash: string | null;
  reviewed: boolean;
  dismissal: string | null;
  disposition: FindingDisposition | null;
};
type Observation = {
  priorRepairs?: { jobId: string; status: string; explanation: string }[];
  id: string;
  lane: string;
  ordinal: number;
  job_id: string;
  package_id: string;
  finding: AuthoringLaneFinding;
  current: boolean;
  finding_ids: string[];
};
type Work = {
  source_candidate?: {
    skillId: string;
    hash: string;
    candidateHash: string;
    purpose: string;
    revision: number;
  } | null;
  id: string;
  kind: string;
  status: string;
  revision: number;
  result: Record<string, unknown> | null;
  finding_ids: string[];
};
type View = {
  questions: {
    findingId: string;
    roundId: string;
    questionId: string;
    workRevision: number;
  }[];
  laneTargets: { id: string; targets: string[] }[];
  pins: { id: string; hash: string; name: string }[];
  existingRepairs: { id: string; status: string; revision: number }[];
  hash: string;
  findings: Finding[];
  observations: Observation[];
  work: Work[];
};
const routes: FindingRoute[] = [
  "implementation",
  "verification",
  "plan",
  "lane",
  "question",
  "sources",
  "dossier",
  "proposal",
  "badger",
];

export function WorkflowFindings({
  basePath,
  path,
  onChanged,
  mapped = false,
}: {
  mapped?: boolean;
  basePath: string;
  path: string;
  onChanged(): void;
}) {
  const { locale, t } = useI18n(),
    words = translations[locale === "zh" ? "zh" : "en"];
  const [view, setView] = useState<View | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const [observationIds, setObservations] = useState<string[]>([]),
    [findingIds, setSelected] = useState<string[]>([]);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [editing, setEditing] = useState(false),
    [existing, setExisting] = useState<string | undefined>();
  const [review, setReview] = useState<Work | null>(null),
    [reason, setReason] = useState(""),
    [explain, setExplain] = useState<{
      id: string;
      action: "dismiss" | "reopen";
    } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    preview: { confirmationHash: string };
    requestId: string;
  } | null>(null);
  const [form] = Form.useForm<FindingDisposition>();
  const route = Form.useWatch("route", form);
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const requestedId = query.get("finding");
  const writerJob = query.get("findingJob");
  const listId = useId();
  useEffect(() => {
    if (requestedId && view?.findings.some((item) => item.id === requestedId))
      document
        .getElementById(listId + "-" + requestedId)
        ?.scrollIntoView({ block: "nearest" });
  }, [listId, requestedId, view?.hash]);
  const [signed, setSigned] = useState(false);
  const [supersede, setSupersede] = useState<string | null>(null);
  const [adoption, setAdoption] = useState<Work | null>(null);
  const url = path + "/package/findings";
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await questionnaireRequest<View>(
        basePath,
        url,
        "GET",
        undefined,
        signal,
      );
      if (!signal?.aborted) setView(next);
    },
    [basePath, url],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setFailure(String(error));
    });
    return () => controller.abort();
  }, [refresh]);
  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    setFailure("");
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function command(args: Record<string, unknown>) {
    return questionnaireRequest<{
      waiting?: { findingId: string; reason: string }[];
    }>(basePath, url, "POST", {
      ...args,
      confirmed: true,
      hash: view?.hash,
      requestId: crypto.randomUUID(),
    });
  }
  function toggle(values: string[], id: string, checked: boolean) {
    return checked
      ? [...new Set([...values, id])]
      : values.filter((value) => value !== id);
  }
  function edit() {
    const observation = view?.observations.find((item) =>
      observationIds.includes(item.id),
    );
    const prior = observation?.finding.disposition;
    form.resetFields();
    setSigned(!!prior?.verifier);
    form.setFieldsValue(
      prior ?? {
        subject: observation?.finding.problem.slice(0, 200) ?? "",
        route: "implementation",
        target: "",
        acceptance: observation?.finding.fix ?? "",
        authority: observation?.finding.evidence?.[0] ?? "",
      },
    );
    setExisting(undefined);
    setEditing(true);
  }
  const selected =
    view?.findings.filter((item) => findingIds.includes(item.id)) ?? [];
  const observations =
    view?.observations.filter(
      (item) => !writerJob || item.job_id === writerJob,
    ) ?? [];
  const linkedFindings = new Set(
    observations.flatMap((item) => item.finding_ids),
  );
  const work =
    view?.work.filter(
      (job) =>
        !writerJob || job.finding_ids.some((id) => linkedFindings.has(id)),
    ) ?? [];
  const currentFindings =
    view?.findings.filter(
      (item) =>
        item.reviewed ||
        view.observations.some(
          (observation) =>
            observation.current && observation.finding_ids.includes(item.id),
        ),
    ) ?? [];
  const visibleFindings = writerJob
    ? currentFindings.filter((item) => linkedFindings.has(item.id))
    : currentFindings;
  const allFindingsQuery = new URLSearchParams(location.search);
  allFindingsQuery.delete("findingJob");
  const dispatch = (kind?: string) =>
    perform(async () => {
      const result = await command({ action: "dispatch", kind, findingIds });
      setWaiting(result.waiting?.map((item) => item.reason) ?? []);
      setSelected(result.waiting?.map((item) => item.findingId) ?? []);
    });
  const inspect = (job: Work) => {
    setReview(job);
    setConfirmation(null);
    setReason("");
  };
  const reviewPath = review ? path + "/drafting-jobs/" + review.id : "";
  async function adoptSource() {
    const candidate = adoption?.source_candidate;
    if (!candidate || !adoption?.result) return;
    const implementation = adoption.result.implementation as {
      changes: { path: string; content: string | null }[];
    };
    const changes = implementation.changes.map((change) => {
      if (change.content === null) return change;
      let binary = "";
      for (const byte of new TextEncoder().encode(change.content))
        binary += String.fromCharCode(byte);
      return { path: change.path, content: btoa(binary) };
    });
    const edit = { baseHash: candidate.hash, changes };
    const { preview } = await previewUpload(basePath, candidate.skillId, edit);
    if (preview.hash !== candidate.candidateHash)
      throw new Error("The Skill preview differs from the reviewed patch.");
    await uploadVersion(
      basePath,
      candidate.skillId,
      edit,
      preview.hash,
      preview.confirmationHash,
    );
    await questionnaireRequest(basePath, path + "/pins", "POST", {
      skillId: candidate.skillId,
      hash: preview.hash,
      purpose: candidate.purpose,
      revision: candidate.revision,
    });
    setAdoption(null);
    onChanged();
  }
  async function accept() {
    if (!review?.result) return;
    const body = { ...review.result, revision: review.revision };
    if (!confirmation) {
      const result = await questionnaireRequest<{
        preview: { confirmationHash: string };
      }>(basePath, reviewPath + "/accept-preview", "POST", body);
      setConfirmation({ ...result, requestId: crypto.randomUUID() });
      return;
    }
    await questionnaireRequest(basePath, reviewPath + "/accept", "POST", {
      ...body,
      confirmed: true,
      confirmationHash: confirmation.preview.confirmationHash,
      requestId: confirmation.requestId,
    });
    setReview(null);
    onChanged();
  }
  if (!view && !failure) return <Spin />;
  return (
    <section aria-label={words.findings}>
      {writerJob && (
        <p>
          {words.writerFindings} ·{" "}
          <Link
            to={{ search: allFindingsQuery.toString(), hash: location.hash }}
          >
            {words.allFindings}
          </Link>
        </p>
      )}
      {!!waiting.length && (
        <Alert
          type="info"
          showIcon
          message={waiting.join(" · ")}
          closable
          onClose={() => setWaiting([])}
        />
      )}
      {failure && (
        <Alert
          type="error"
          showIcon
          message={failure}
          onClose={() => setFailure("")}
          closable
        />
      )}
      <Space wrap>
        <Button disabled={busy} onClick={() => void perform(async () => {})}>
          {words.refresh}
        </Button>
        <Button disabled={busy || !observationIds.length} onClick={edit}>
          {words.group}
        </Button>
        <Button
          disabled={busy || !selected.length}
          onClick={() => void dispatch("draft-dispositions")}
        >
          {words.draft}
        </Button>
        <Button
          type="primary"
          disabled={
            busy ||
            !selected.length ||
            selected.some(
              (item) =>
                !item.reviewed ||
                (mapped && item.disposition?.route === "plan") ||
                !["implementation", "verification", "plan", "lane"].includes(
                  item.disposition?.route ?? "",
                ),
            )
          }
          onClick={() => void dispatch()}
        >
          {words.dispatch}
        </Button>
        <Button
          disabled={
            busy ||
            !selected.length ||
            selected.some(
              (item) =>
                !item.reviewed ||
                !item.subjectHash ||
                item.disposition?.route === "badger",
            )
          }
          onClick={() => void dispatch("verify-finding")}
        >
          {words.verify}
        </Button>
      </Space>
      {view && (
        <>
          {!writerJob &&
            view.existingRepairs?.map((job) => (
              <Space key={job.id} wrap>
                <Link to={{ search: "?planDraft=" + job.id, hash: "#plan" }}>
                  {words.repair}
                </Link>
                <Tag>{job.status}</Tag>
                <Button
                  disabled={busy || job.status === "claimed"}
                  size="small"
                  onClick={() => setSupersede(job.id)}
                >
                  {words.replace}
                </Button>
              </Space>
            ))}
          <h4>{words.observations}</h4>
          <List
            size="small"
            locale={{ emptyText: words.empty }}
            dataSource={observations}
            renderItem={(item) => (
              <List.Item>
                <div>
                  <Checkbox
                    disabled={!item.current}
                    checked={observationIds.includes(item.id)}
                    onChange={(event) =>
                      setObservations(
                        toggle(observationIds, item.id, event.target.checked),
                      )
                    }
                  >
                    {item.lane} #{item.ordinal + 1} · {item.finding.problem}
                  </Checkbox>
                  {!item.current && <Tag>{words.history}</Tag>}
                  <details>
                    <summary>{words.details}</summary>
                    <small>
                      {item.package_id} / {item.job_id}
                    </small>
                    {item.finding.fix && <p>{item.finding.fix}</p>}
                    {item.priorRepairs?.map((repair) => (
                      <p key={repair.jobId}>
                        <Link
                          to={{
                            search: "?planDraft=" + repair.jobId,
                            hash: "#plan",
                          }}
                        >
                          {words.repair}
                        </Link>{" "}
                        · {repair.status} · {repair.explanation}
                      </p>
                    ))}
                    <ul>
                      {item.finding.evidence?.map((citation, index) => (
                        <li key={index}>{citation}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </List.Item>
            )}
          />
          <h4>{words.findings}</h4>
          <List
            size="small"
            locale={{ emptyText: words.empty }}
            dataSource={visibleFindings}
            renderItem={(item) => (
              <List.Item id={listId + "-" + item.id}>
                <div>
                  <Checkbox
                    checked={findingIds.includes(item.id)}
                    disabled={!!item.dismissal}
                    onChange={(event) =>
                      setSelected(
                        toggle(findingIds, item.id, event.target.checked),
                      )
                    }
                  >
                    {item.problem}
                  </Checkbox>{" "}
                  <Tag>{words[item.status]}</Tag>
                  {item.disposition && (
                    <div>
                      {mapped && item.disposition.route === "plan"
                        ? words.mappedPlan
                        : words[item.disposition.route]}{" "}
                      · <code>{item.disposition.target}</code>
                      <p>{item.disposition.acceptance}</p>
                      {item.disposition.due && (
                        <p>
                          {t("mapping.evidenceDue")}{" "}
                          {t(`mapping.due.${item.disposition.due}`)}
                        </p>
                      )}
                    </div>
                  )}
                  {mapped && item.disposition?.route === "plan" && (
                    <Link
                      to={{
                        search:
                          "?mapTab=contract&finding=" +
                          encodeURIComponent(item.id),
                        hash: "mapping",
                      }}
                    >
                      {words.mapBehavior}
                    </Link>
                  )}
                  {item.disposition &&
                    ["sources", "dossier", "proposal"].includes(
                      item.disposition.route,
                    ) && (
                      <Link
                        to={{
                          hash:
                            (
                              {
                                question: "questionnaire",
                                lane: "package",
                              } as Record<string, string>
                            )[item.disposition.route] ?? item.disposition.route,
                        }}
                      >
                        {words.stage}
                      </Link>
                    )}
                  {item.reviewed &&
                    item.disposition?.route === "question" &&
                    !item.dismissal && (
                      <Space wrap>
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await command({
                                action: "ask-expert",
                                findingId: item.id,
                              });
                            })
                          }
                        >
                          {words.question}
                        </Button>
                        {view.questions
                          .filter((q) => q.findingId === item.id)
                          .map((q) => {
                            const ids = path.split("/");
                            return (
                              <Link
                                key={q.questionId}
                                to={{
                                  pathname: "/questionnaire",
                                  search:
                                    "?" +
                                    new URLSearchParams({
                                      workflow: ids[2],
                                      version: ids[4],
                                      round: q.roundId,
                                    }).toString(),
                                }}
                              >
                                {words.stage}
                              </Link>
                            );
                          })}
                      </Space>
                    )}
                  {item.subjectHash &&
                    item.disposition?.target.startsWith("implementation/") && (
                      <small>
                        {words.resolved} <code>{item.subjectHash}</code>
                      </small>
                    )}
                  <Button
                    type="link"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setExplain({
                        id: item.id,
                        action: item.dismissal ? "reopen" : "dismiss",
                      });
                    }}
                  >
                    {item.dismissal ? words.reopen : words.dismiss}
                  </Button>
                  {!item.dismissal &&
                    view.work.some(
                      (job) =>
                        job.status === "accepted" &&
                        job.finding_ids.includes(item.id),
                    ) && (
                      <Button
                        type="link"
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          setReason("");
                          setExplain({ id: item.id, action: "reopen" });
                        }}
                      >
                        {words.reopen}
                      </Button>
                    )}
                </div>
              </List.Item>
            )}
          />
          {!!work.length && (
            <>
              <h4>{words.work}</h4>
              <List
                size="small"
                dataSource={work}
                renderItem={(job) => (
                  <List.Item>
                    <Space wrap>
                      <span>{job.kind}</span>
                      <Tag>{job.status}</Tag>
                      {["queued", "claimed", "submitted"].includes(
                        job.status,
                      ) && (
                        <AgentPromptButton
                          basePath={basePath}
                          path={path + "/drafting-jobs/" + job.id + "/prompt"}
                        />
                      )}
                      {job.source_candidate &&
                        view.pins?.some(
                          (pin) =>
                            pin.id === job.source_candidate!.skillId &&
                            pin.hash === job.source_candidate!.hash,
                        ) && (
                          <Button size="small" onClick={() => setAdoption(job)}>
                            {words.adoptSource}
                          </Button>
                        )}
                      {job.result &&
                        (job.kind === "draft-plan" ? (
                          <Link
                            to={{
                              search: "?planDraft=" + job.id,
                              hash: "#plan",
                            }}
                          >
                            {words.review}
                          </Link>
                        ) : (
                          <Button size="small" onClick={() => inspect(job)}>
                            {words.review}
                          </Button>
                        ))}
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </>
      )}
      <Modal
        title={words.group}
        open={editing}
        onCancel={() => setEditing(false)}
        okText={words.save}
        confirmLoading={busy}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(disposition) =>
            void perform(async () => {
              await command({
                action: "group",
                observationIds,
                disposition: {
                  ...disposition,
                  verifier: signed ? disposition.verifier : undefined,
                },
                findingId: existing,
              });
              setEditing(false);
              setObservations([]);
            })
          }
        >
          <Form.Item label={words.link}>
            <Select
              allowClear
              value={existing}
              placeholder={words.new}
              options={currentFindings
                .filter((item) => item.reviewed && item.disposition)
                .map((item) => ({ value: item.id, label: item.problem }))}
              onChange={(id) => {
                setExisting(id);
                const prior = view?.findings.find(
                  (item) => item.id === id,
                )?.disposition;
                if (prior) {
                  form.setFieldsValue(prior);
                  setSigned(!!prior.verifier);
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label={words.subject}
            name="subject"
            rules={[{ required: true }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item
            label={words.route}
            name="route"
            rules={[{ required: true }]}
          >
            <Select
              options={routes.map((route) => ({
                value: route,
                label:
                  mapped && route === "plan" ? words.mappedPlan : words[route],
              }))}
            />
          </Form.Item>
          <Form.Item
            label={words.target}
            name="target"
            rules={[{ required: true }]}
          >
            {route === "lane" ? (
              <Select
                showSearch
                options={view?.laneTargets.map((lane) => ({
                  label: lane.id,
                  options: [...new Set([lane.id, ...lane.targets])].map(
                    (value) => ({ label: value, value }),
                  ),
                }))}
              />
            ) : (
              <Input />
            )}
          </Form.Item>
          <Form.Item
            label={words.authority}
            name="authority"
            rules={[{ required: true }]}
          >
            <Input.TextArea />
          </Form.Item>
          <Form.Item label={words.skill} name="sourceSkillId">
            <Select
              allowClear
              placeholder={words.local}
              options={view?.pins?.map((pin) => ({
                label: pin.name,
                value: pin.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="due" label={words.due} initialValue="assembly">
            <Select
              options={[
                {
                  value: "assembly",
                  label: locale === "zh" ? "组装" : "Assembly",
                },
                {
                  value: "review",
                  label: locale === "zh" ? "软件包审核" : "Package review",
                },
                {
                  value: "run",
                  label: locale === "zh" ? "运行决策" : "Run decision",
                },
              ]}
            />
          </Form.Item>
          <Form.Item name="dependsOn" label={words.dependency}>
            <Select
              mode="multiple"
              options={currentFindings
                .filter(
                  (item) =>
                    item.reviewed && !item.dismissal && item.id !== existing,
                )
                .map((item) => ({ value: item.id, label: item.problem }))}
            />
          </Form.Item>
          <Form.Item
            name="environment"
            label={
              locale === "zh"
                ? "需验证的环境与工具版本（可选）"
                : "Required test environment and tool versions (optional)"
            }
            normalize={(value) => value || undefined}
          >
            <Input />
          </Form.Item>
          <Checkbox
            checked={signed}
            onChange={(event) => setSigned(event.target.checked)}
          >
            {words.signed}
          </Checkbox>
          {signed && (
            <>
              <Form.Item
                name={["verifier", "nodeId"]}
                label={words.node}
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name={["verifier", "requirementId"]}
                label={words.requirement}
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </>
          )}
          <Form.Item
            label={words.acceptance}
            name="acceptance"
            rules={[{ required: true }]}
          >
            <Input.TextArea />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={!!supersede}
        title={words.replace}
        onCancel={() => setSupersede(null)}
        okText={words.confirm}
        confirmLoading={busy}
        onOk={() =>
          void perform(async () => {
            await command({ action: "supersede-plan", jobId: supersede });
            setSupersede(null);
          })
        }
      >
        <p>
          {locale === "zh"
            ? "取消所选修复任务，保留其记录。"
            : "Cancel this repair and retain its history. Individual finding assignments can then be dispatched."}
        </p>
      </Modal>
      <Modal
        open={!!adoption}
        title={words.adoptSource}
        onCancel={() => setAdoption(null)}
        okText={words.confirm}
        confirmLoading={busy}
        onOk={() => void perform(adoptSource)}
      >
        <p>
          {locale === "zh"
            ? "确认导入新的技能版本并替换此工作流固定的版本。"
            : "Import the reviewed Skill version and replace this workflow’s pin."}
        </p>
        <code>{adoption?.source_candidate?.candidateHash}</code>
      </Modal>
      <Modal
        title={words.review}
        open={!!review}
        onCancel={() => setReview(null)}
        okText={confirmation ? words.confirm : words.adopt}
        okButtonProps={{ disabled: review?.status !== "submitted" }}
        onOk={() => void perform(accept)}
        confirmLoading={busy}
      >
        <pre
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: "50vh",
            overflow: "auto",
          }}
        >
          {JSON.stringify(review?.result, null, 2)}
        </pre>
        {review?.status === "submitted" && (
          <>
            <Input.TextArea
              aria-label={words.reason}
              placeholder={words.reason}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              disabled={busy || !reason.trim()}
              onClick={() =>
                void perform(async () => {
                  await questionnaireRequest(
                    basePath,
                    reviewPath + "/return-plan",
                    "POST",
                    { confirmed: true, revision: review.revision, reason },
                  );
                  setReview(null);
                })
              }
            >
              {words.back}
            </Button>
          </>
        )}
      </Modal>
      <Modal
        title={explain?.action === "reopen" ? words.reopen : words.dismiss}
        open={!!explain}
        onCancel={() => setExplain(null)}
        okText={words.confirm}
        okButtonProps={{ disabled: !reason.trim() }}
        onOk={() =>
          void perform(async () => {
            await command({
              action: explain?.action,
              findingId: explain?.id,
              reason,
            });
            setExplain(null);
          })
        }
      >
        <Input.TextArea
          aria-label={words.reason}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>
    </section>
  );
}
