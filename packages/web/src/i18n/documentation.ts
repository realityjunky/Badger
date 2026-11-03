/** Dashboard help is translated; canonical package documentation stays English. */
export const documentationEn = {
  "documentation.title": "Documentation",
  "documentation.tooltip": "Open the guide for this section",
  "documentation.sections": "Guide sections",
  "documentation.close": "Close documentation",
  "documentation.return": "Return to dashboard",
  "documentation.intro":
    "Use this guide alongside your work. Closing it returns to the same page with your selections and edits retained.",
  "documentation.signOff":
    "Agents draft; signed-in people sign off. Review the evidence and exact hashes in each confirmation dialog before confirming, acknowledging, approving, publishing, or answering a Run gate. An Agent or personal access token cannot sign off for you.",
  "documentation.demo":
    "In demo mode, records and examples are synthetic and read-only. Documentation remains available; appearance and language choices last only for this visit.",
  "documentation.roles": "Who can act",
  "documentation.actions": "Important actions",
  "documentation.next": "Next step",
  "documentation.administration": "Administration",
  "documentation.my-work.purpose":
    "My work brings together the work waiting for you: assigned Questions, restatements to acknowledge, and confirmations or Run gates that need your attention.",
  "documentation.my-work.roles":
    "Each signed-in person sees their own inbox and the workflows their roles allow them to read. Opening an inbox item does not grant permission to act on its target.",
  "documentation.my-work.inbox":
    "Open an inbox item to reach its Question, Workflow version, or Run. Mark items read or unread to keep track of what you have reviewed.",
  "documentation.my-work.scope":
    "Use the Group, Workflow, and version selectors to narrow your work, or use Search to find a workflow, Question, or Skill. The bell opens your inbox from any page.",
  "documentation.my-work.next":
    "Follow the item to its evidence, review what changed, and use the action offered for your role. Return to My work to find the next item.",
  "documentation.workflows.purpose":
    "Workflows holds the workflow frame, team, and version history. Select a Workflow version to follow its eight-stage track. Uploading a Skill to a Group's library only makes a source available; it does not pin it, study it, answer a Question, or confirm any stage.",
  "documentation.workflows.roles":
    "Group leads and Administrators create workflows; Workflow owners also edit their workflow and assign its team. Engineers pin sources, confirm Sources, complete Source study, and build and evaluate packages. Workflow owners approve dossiers, plans, proposals, and packages and confirm publication. Administrators can perform these actions. Other readers inspect the records their roles permit.",
  "documentation.workflows.sources":
    "1. Sources: choose a Skill from the workflow's Group library and pin one immutable version hash. Review the source check and explicitly confirm the source set. Changing pins invalidates this confirmation and requires a fresh check.",
  "documentation.workflows.study":
    "2. Source study: the Engineer reads each pinned Skill, records source-derived Facts with line evidence, interfaces, and open questions, then reviews and confirms that exact version as studied. A library upload or source pin does not complete this reading.",
  "documentation.workflows.questionnaire":
    "3. Questionnaire: publish Questions to assigned people, collect Answers, resolve Questions, and review the Ledger. Engineers confirm Facts restated from Answers; answering Field experts acknowledge or dispute those restatements. These are separate actions from Source study.",
  "documentation.workflows.dossier":
    "4. Dossier: the Engineer composes the Semantic dossier from current evidence, Node responsibilities, and topic summaries. The Workflow owner reviews and approves its exact immutable version.",
  "documentation.workflows.plan":
    "5. Plan and proposal: the Engineer saves the FactoryPlan; the Workflow owner approves the plan and the kernel's exact Proposal. The Engineer then confirms Project initialization.",
  "documentation.workflows.package":
    "6. Package: the Engineer previews and confirms generation, requests ready Authoring lanes, reviews their claims and content, confirms acceptance or rejection, and confirms assembly once all required lanes are current.",
  "documentation.workflows.evaluation":
    "7. Evaluation: the Engineer confirms a certification job for the assembled package's exact hash and inspects its retained report. Domain scripts never run during this evaluation.",
  "documentation.workflows.publication":
    "8. Review and publication: the Workflow owner reviews the passing evaluation, confirms package approval, then separately confirms publication of those exact bytes. Later changes require current evidence and a new review; existing publications remain available.",
  "documentation.workflows.next":
    "Open the first incomplete stage and resolve its named blockers. Use Questionnaire for missing domain knowledge. After publication, use Install locally to preview the host command and confirm its separate commit on your computer.",
  "documentation.questionnaire.purpose":
    "Questionnaire collects the workflow knowledge needed to build a package. Select a workflow and version, then use the explorer, main record, and inspector to follow a Question or Concern and its evidence.",
  "documentation.questionnaire.roles":
    "Engineers compose and publish Questions and Rounds, resolve Answers, and confirm Facts. Assigned people answer Questions; Field experts acknowledge or dispute Facts restated from their Answers and can raise Concerns. Workflow roles other than Observer can comment. Observers and Auditors read without changing records.",
  "documentation.questionnaire.answer":
    "Read the Question, its reason, requested answer format, and evidence before saving an Answer. Use the thread for discussion and attach synthetic examples when useful. Answer revisions retain their history.",
  "documentation.questionnaire.resolve":
    "The Engineer reviews an Answer and records a Resolution: confirm it, ask a follow-up, defer with a reason, or withdraw. A confirmed Fact restating an expert's Answer still needs that expert's acknowledgement; a dispute reopens the Question.",
  "documentation.questionnaire.ledger":
    "Inspect the Ledger's confirmed user Facts, source-derived Facts, Inferences, unresolved Assumptions, and remaining Questions. Review an Agent's drafting result before accepting it; an unaccepted draft is not an agreed Fact.",
  "documentation.questionnaire.next":
    "Clear the open Questions, acknowledgement requests, and readiness blockers. The Engineer can then compose the dossier in Workflows using the current Ledger evidence.",
  "documentation.skills.purpose":
    "Skills is a Group's shared source library. An entry can hold several immutable Skill versions. A workflow uses a source only after an Engineer pins a specific version to its Workflow version.",
  "documentation.skills.roles":
    "Administrators and Group leads can Add Skill. Engineers and Field experts can Add Skill and upload or import versions in the exact Group of a workflow where they hold that role. A Group lead needs such a workflow assignment to upload; Administrators can upload everywhere. Group Members and workflow readers can inspect the sources they can access. Engineers pin versions in Workflows.",
  "documentation.skills.add":
    "Add Skill: choose the owning Group and a name to create a library entry. Open the entry, then choose Upload version or Import from Git. Creating an entry alone adds no source files.",
  "documentation.skills.upload":
    "Folder or zip: choose the Skill folder or a zip of its files. Include SKILL.md, instructions, scripts, and synthetic examples; exclude .git, real biological data, and secret values. The dashboard previews the selected source before a version is created.",
  "documentation.skills.git":
    "Git import: register a repository URL permitted by the deployment, select it, and provide the full commit hash, rather than a branch or tag. Preview commit inspects those files. Registration alone fetches nothing. Use a folder upload if the repository needs credentials or unsupported content such as Git LFS.",
  "documentation.skills.inventory":
    "Review the source inventory's file count and source hash in the upload preview. After upload, use the file tree, Inventory tab (paths, sizes, and file hashes), read-only file previews, and version comparison to inspect stored versions. Uploading, importing, and previewing never execute uploaded scripts.",
  "documentation.skills.confirm":
    "Review the inventory and exact hash, then use Confirm immutable upload (or Confirm immutable import). Effects stay pending without a model connection. In Source study, the Engineer's Agent drafts effects and the original uploader corrects rows, answers uncertainties, and personally confirms the complete set. The same entry/version's confirmation is reusable; corrections append history and reopen dependent work without changing files.",
  "documentation.skills.next":
    "Open the target Workflow version, pin the immutable Skill hash, and confirm Sources. Read-only study and ordinary Questionnaire work remain available while effect review is pending. Final study completion requires complete uploader-confirmed script coverage.",
  "documentation.effects.link": "Understand script side-effect declarations",
  "documentation.effects.intro":
    "A declaration describes what a script could do when executed later. It does not run the script or grant it permission. Inspect the script, subprocesses, wrappers, and supported optional execution modes; declare possible behavior across those paths, not only one selected run. If you are unsure, inspect the source or ask its author before confirming; do not default to none.",
  "documentation.effects.combine":
    "Combine every applicable effect, for example local-writes plus network for a downloader that saves a file. none is exclusive: select it only when none of the four listed effects can occur. Selecting none clears other effects, and selecting another effect removes none.",
  "documentation.effects.none":
    "None of the listed effects. Example: a computation that only reports its result to stdout/stderr. Writing output files, logs, caches, or temporary files does not qualify as none.",
  "documentation.effects.local-writes":
    "Creating, modifying, or deleting local files or directories. Examples: writing report.txt, appending a log, creating a cache, removing a directory, or using temporary files, even if they are cleaned up later.",
  "documentation.effects.network":
    "Requests, downloads, uploads, or calls to remote services. Examples: fetching a synthetic fixture from https://example.org, uploading a synthetic report, or calling a remote API, including through a subprocess.",
  "documentation.effects.scheduler-submission":
    "Submitting work to a scheduler. Example: a shell wrapper that invokes qsub to submit a synthetic job to SGE. Include other effects too if the wrapper writes a job file or contacts a remote service.",
  "documentation.effects.installs":
    "Installing or changing tools, dependencies, or environments. Examples: pip install, npm install, conda create, or a wrapper that updates an environment. Also declare local-writes or network when those effects are possible.",
  "documentation.effects.noScripts":
    "If the source inventory contains no scripts, there is nothing to declare. Review the files and confirm the upload without adding artificial declarations.",
  "documentation.runs.purpose":
    "Runs shows durable executions of published packages: status, current Node, pending action, computer, and recovery state. Open a Run to inspect its publication, package hash, Attempts, artifact receipts, findings, and Events.",
  "documentation.runs.roles":
    "Operators drive their published workflow through an Agent on the Run's computer. A signed-in person with the authority named by a Run gate answers it in the dashboard. Workflow readers and Auditors inspect the Run evidence their roles permit.",
  "documentation.runs.gates":
    "For a waiting Run, review the gate's choices, inputs, rationale, and bound evidence. Review answer opens a confirmation dialog that records your signed-in identity and current authorities at the shown Run revision. Confirm only the answer you reviewed; the Agent receives it on its next next or status call.",
  "documentation.runs.recovery":
    "For a Run marked as needing recovery, ask the Operator's Agent to use recover on the Run's computer. Inspect the reported recovery outcome and integrity findings. Use Events to read earlier evidence when the outcome summary is limited to recent entries.",
  "documentation.runs.next":
    "After answering a gate, let the Operator's Agent continue. If recovery remains unsettled, inspect its evidence with the Operator before proceeding.",
  "documentation.evaluations.purpose":
    "Evaluations certifies an assembled package and keeps reports tied to its exact package hash. A passing report for an earlier package does not qualify the current one for publication.",
  "documentation.evaluations.roles":
    "Engineers and Administrators start evaluations. Workflow readers inspect the permitted reports; the Workflow owner uses the current passing evidence when reviewing the package for publication.",
  "documentation.evaluations.start":
    "Select a workflow and version, inspect the current assembled package, then Start evaluation. The confirmation explains the bounded certification job, that domain scripts never execute, and that the report is retained. Confirm and follow its progress or return when the inbox announces completion.",
  "documentation.evaluations.report":
    "Open a report to review package checks, Authoring cross-validation, certification phases and negative cases, duration, and artifact receipts. Compare its hash with the current package and fix reported blockers before evaluating changed content.",
  "documentation.evaluations.next":
    "With a passing report for the current hash, return to Workflows → Review and publication for the Workflow owner's explicit approval and publication confirmations.",
  "documentation.activity.purpose":
    "Activity is the append-only record of who acted, when, on what target, through which channel, and with what reason. It supports review and investigation rather than editing history.",
  "documentation.activity.roles":
    "Administrators and Auditors can read the Organization's full Activity log. Access to other work is controlled by its own roles; reading an event does not authorize a change.",
  "documentation.activity.filter":
    "Use the actor, action, target, and time filters and Apply filters to narrow recorded events. Open the target when a link is offered and compare the event with its current record and history.",
  "documentation.activity.reason":
    "Read recorded confirmation evidence and Administrator override reasons when investigating a blocked or changed action. The log preserves the original actor and event; it cannot be rewritten here.",
  "documentation.activity.next":
    "Follow the relevant workflow, Question, or Run and ask its responsible person to resolve the issue through the normal reviewed action.",
  "documentation.admin.purpose":
    "Administration contains Members, Groups, Invitations, and Integrations. It manages the people and access behind the workflow teams; it does not replace workflow-specific sign-off.",
  "documentation.admin.roles":
    "Administrators manage Organization access and Groups. Group leads manage the Groups they lead and nested Groups within their authority. Auditors read without changing records; integration status is available to Administrators and Auditors.",
  "documentation.admin.members":
    "Inspect Members and their role bindings. In Groups, create or open a Group, review its members, and assign or remove the roles permitted at that scope. Group bindings apply to nested Groups; workflow bindings apply only to that workflow and its versions.",
  "documentation.admin.invitations":
    "Use Invitations to invite a verified email identity into a role, review pending invitations, or resend delivery. Review any removal confirmation. If an Administrator overrides a refused action, provide the required reason; the Activity log records it.",
  "documentation.admin.integrations":
    "Use Integrations to inspect the service's configured connections and status. Configuration that belongs to the deployment is managed by its administrator outside this dashboard. Administration actions are unavailable in demo mode.",
  "documentation.admin.next":
    "Return to the workflow's team to check assignments, or ask the new person to sign in with their verified invited email and open My work.",
  "documentation.settings.purpose":
    "Personal settings controls your appearance, language, notification choices, personal access tokens, and delivery channels. Appearance and language are personal and do not change other people's settings or rewrite record content.",
  "documentation.settings.roles":
    "Each signed-in person manages their own preferences and tokens. Tokens are limited by the person's roles and selected MCP profiles. Workflow notification channels also require the management authority shown by the dashboard.",
  "documentation.settings.preferences":
    "Choose Light, Dark, or System, adjust text size, or collapse navigation. Select English or 中文 here or with Language in the top bar. Check the saved or failed status; a failed save only applies locally until it succeeds. In demo mode only appearance and language are available for this visit.",
  "documentation.settings.tokens":
    "In Personal access tokens, select the scopes your Agent needs, review creation, and copy the secret when shown once. Keep it private and revoke unused tokens. Use the MCP setup instructions for your Agent host; a token can draft within its scopes but cannot approve or answer gates for you.",
  "documentation.settings.notifications":
    "Choose notification events, set your mention identity, and manage permitted Group robot channels. Use delivery history to investigate a failed notification without sharing webhook secrets.",
  "documentation.settings.next":
    "Return to My work or your workflow. Confirm that your Agent uses the intended profile and that important requests reach your chosen notification channel.",
} as const;

export const documentationZh: Record<keyof typeof documentationEn, string> = {
  "documentation.title": "使用文档",
  "documentation.tooltip": "打开当前页面的使用指南",
  "documentation.sections": "指南章节",
  "documentation.close": "关闭使用文档",
  "documentation.return": "返回工作页面",
  "documentation.intro":
    "可在工作过程中随时查阅本指南。关闭后会回到原来的页面，并保留已选择的内容与编辑。",
  "documentation.signOff":
    "Agent 起草，已登录的人员签署确认。确认、认可、批准、发布或回答运行关卡前，请审阅确认对话框中的证据与确切哈希。Agent 和个人访问令牌不能替您签署确认。",
  "documentation.demo":
    "演示模式中的记录与示例均为合成内容且只读。仍可查看使用文档；外观与语言选择仅在本次访问期间生效。",
  "documentation.roles": "谁可以操作",
  "documentation.actions": "主要操作",
  "documentation.next": "下一步",
  "documentation.administration": "管理",
  "documentation.my-work.purpose":
    "“我的工作”汇总等待您处理的事项：分配给您的问题、需要认可的事实重述，以及待确认事项或运行关卡。",
  "documentation.my-work.roles":
    "每位已登录人员查看自己的收件箱，以及其角色允许读取的工作流。打开消息不会授予处理该事项的权限。",
  "documentation.my-work.inbox":
    "打开收件箱消息可进入对应的问题、工作流版本或运行。使用已读和未读标记跟踪已审阅的内容。",
  "documentation.my-work.scope":
    "使用团队、工作流和版本选择器缩小范围，或通过搜索查找工作流、问题或 Skill。可从任意页面的铃铛打开收件箱。",
  "documentation.my-work.next":
    "跟随消息查看证据，审阅变更，并使用您的角色可执行的操作。返回“我的工作”继续处理下一项。",
  "documentation.workflows.purpose":
    "“工作流”管理工作流框架、团队和版本历史。选择工作流版本后，可沿八个阶段推进。将 Skill 上传到团队库仅使来源可用，不会自动固定版本、完成研读、回答问题或确认任何阶段。",
  "documentation.workflows.roles":
    "团队负责人和管理员创建工作流；工作流负责人也可编辑自己的工作流并分配团队角色。工程师固定来源、确认来源、完成来源研读，并构建和评估软件包。工作流负责人批准语义档案、计划、提案和软件包，并确认发布。管理员可以执行这些操作。其他读者查看其角色允许访问的记录。",
  "documentation.workflows.sources":
    "1. 来源：从工作流所属团队的库中选择 Skill，固定一个不可变版本的哈希。审阅来源检查并明确确认来源集合。更改固定版本会使本次确认失效，必须重新检查。",
  "documentation.workflows.study":
    "2. 来源研读：工程师阅读每个固定的 Skill，记录带有行号证据的来源事实、接口和未决问题，然后审阅并确认该确切版本已研读。上传到库或固定来源都不等于完成阅读。",
  "documentation.workflows.questionnaire":
    "3. 问卷：向指定人员发布问题、收集回答、解决问题并审阅台账。工程师确认从回答重述的事实；作答的领域专家认可或质疑这些重述。这些操作与来源研读相互独立。",
  "documentation.workflows.dossier":
    "4. 语义档案：工程师根据当前证据、节点职责和主题摘要编写语义档案。工作流负责人审阅并批准其确切的不可变版本。",
  "documentation.workflows.plan":
    "5. 计划与提案：工程师保存 FactoryPlan；工作流负责人批准计划和内核生成的确切提案，之后由工程师确认项目初始化。",
  "documentation.workflows.package":
    "6. 软件包：工程师预览并确认生成，请求已就绪的创作通道，审阅声明和内容，确认接受或拒绝，并在所有必需通道都为最新状态时确认组装。",
  "documentation.workflows.evaluation":
    "7. 评估：工程师针对组装后软件包的确切哈希确认认证任务，并检查保留的报告。评估期间绝不执行领域脚本。",
  "documentation.workflows.publication":
    "8. 审核与发布：工作流负责人审阅通过的评估，确认批准软件包，再单独确认发布这些确切字节。后续变更需要当前证据和重新审核；已有发布版本仍然可用。",
  "documentation.workflows.next":
    "打开第一个未完成阶段，处理列出的阻碍。缺少领域知识时使用“问卷”。发布后，通过“本地安装”预览主机命令，并在自己的计算机上单独确认提交。",
  "documentation.questionnaire.purpose":
    "“问卷”收集构建软件包所需的工作流知识。选择工作流与版本，通过浏览区、主记录和检查区跟进问题、关注事项及其证据。",
  "documentation.questionnaire.roles":
    "工程师编写并发布问题和轮次、解决回答并确认事实。被分配的人员回答问题；领域专家认可或质疑从其回答重述的事实，也可提出关注事项。除观察者外的工作流角色可评论。观察者和审计员只读，不更改记录。",
  "documentation.questionnaire.answer":
    "保存回答前，阅读问题、提问原因、要求的回答格式与证据。通过讨论串交流，并在需要时附上合成示例。回答的每次修订都会保留历史。",
  "documentation.questionnaire.resolve":
    "工程师审阅回答并记录解决结果：确认、提出追问、说明原因后暂缓，或撤回。从专家回答重述的已确认事实仍需该专家认可；质疑会重新打开问题。",
  "documentation.questionnaire.ledger":
    "检查台账中的已确认用户事实、来源事实、推断、未决假设和剩余问题。接受 Agent 起草结果前先审阅；尚未接受的草稿不是已达成共识的事实。",
  "documentation.questionnaire.next":
    "处理未解决问题、待认可请求及就绪阻碍后，工程师可返回“工作流”，根据当前台账证据编写语义档案。",
  "documentation.skills.purpose":
    "“Skills”是团队共享的来源库。一个条目可以包含多个不可变 Skill 版本。只有工程师将某个确切版本固定到工作流版本后，该工作流才会使用它。",
  "documentation.skills.roles":
    "管理员和团队负责人可添加 Skill。工程师与领域专家可在其所任角色的工作流直接所属团队中添加 Skill、上传或导入版本。团队负责人需要这样的工作流角色才能上传；管理员可在所有团队上传。团队成员和工作流读者可检查有权访问的来源。工程师在“工作流”中固定版本。",
  "documentation.skills.add":
    "添加 Skill：选择所属团队和名称以创建库条目。打开条目后，选择“上传版本”或“从 Git 导入”。仅创建条目不会添加来源文件。",
  "documentation.skills.upload":
    "文件夹或 zip：选择 Skill 文件夹或包含其文件的 zip。内容应包括 SKILL.md、说明、脚本和合成示例；排除 .git、真实生物数据和秘密值。创建版本前，仪表盘会先预览选中的来源。",
  "documentation.skills.git":
    "Git 导入：登记部署允许的仓库 URL，选中仓库并填写完整提交哈希，而不是分支或标签。“预览提交”会检查这些文件。仅登记仓库不会获取内容。仓库需要凭据或使用 Git LFS 等不支持的内容时，请改用文件夹上传。",
  "documentation.skills.inventory":
    "审阅上传预览中的来源清单文件数与来源哈希。上传后，通过文件树、清单标签页（路径、大小和文件哈希）、只读文件预览与版本比较检查已存储版本。上传、导入和预览绝不执行上传的脚本。",
  "documentation.skills.confirm":
    "审阅清单与精确哈希，再确认上传或导入不可变版本。无需模型连接，脚本影响保持待审阅。来源研读时，由工程师的 Agent 起草，原上传人更正各行、回答不确定事项并亲自确认完整声明。同一条目和版本可复用确认；更正会追加历史并重新开启依赖工作，不改动文件。",
  "documentation.skills.next":
    "打开目标工作流版本，固定 Skill 的不可变哈希并确认来源。脚本影响待审阅时，仍可只读研读及开展普通问卷工作。最终完成研读需要上传人确认完整的脚本声明。",
  "documentation.effects.link": "了解脚本副作用声明",
  "documentation.effects.intro":
    "声明描述脚本以后执行时可能做什么，不会运行脚本或授予权限。请检查脚本、子进程、包装脚本，以及支持的可选执行模式；声明应覆盖这些路径的可能行为，而非仅针对某一次运行。不确定时，请先检查来源或询问作者，不要默认选择 none。",
  "documentation.effects.combine":
    "可组合所有适用的副作用，例如下载并保存文件需选择 local-writes 和 network。none 是排他选项：仅在其余四类副作用均不可能发生时选择。选择 none 会清除其他选项，选择其他选项会移除 none。",
  "documentation.effects.none":
    "不产生所列的任何副作用。例如仅向 stdout/stderr 报告结果的计算。写入输出文件、日志、缓存或临时文件都不属于 none。",
  "documentation.effects.local-writes":
    "创建、修改或删除本地文件或目录。例如写入 report.txt、追加日志、创建缓存、删除目录，或使用临时文件，即使之后会清理也需声明。",
  "documentation.effects.network":
    "请求、下载、上传或调用远程服务。例如从 https://example.org 获取合成示例、上传合成报告或调用远程 API，包括通过子进程进行这些操作。",
  "documentation.effects.scheduler-submission":
    "向调度器提交任务。例如 shell 包装脚本通过 qsub 向 SGE 提交合成任务。如果包装脚本还会写入任务文件或访问远程服务，也需声明相应副作用。",
  "documentation.effects.installs":
    "安装或更改工具、依赖项或环境。例如 pip install、npm install、conda create，或通过包装脚本更新环境。可能写入本地或访问网络时，也需声明 local-writes 或 network。",
  "documentation.effects.noScripts":
    "如果来源清单中没有脚本，就无需声明副作用。审阅文件后即可确认上传，不需要人为添加声明。",
  "documentation.runs.purpose":
    "“运行”显示已发布软件包的持久执行状态：当前节点、待处理操作、计算机及恢复状态。打开运行可查看发布版本、软件包哈希、尝试、产物凭据、发现和事件。",
  "documentation.runs.roles":
    "操作员通过运行所在计算机上的 Agent 驱动已发布工作流。拥有运行关卡指定权限的已登录人员在仪表盘回答关卡。工作流读者和审计员可检查其角色允许查看的运行证据。",
  "documentation.runs.gates":
    "运行等待人员处理时，审阅关卡选项、输入、理由及绑定的证据。“审阅回答”会打开确认对话框，记录您的登录身份、当前权限和显示的运行修订号。仅确认已审阅的回答；Agent 会在下一次 next 或 status 调用中收到结果。",
  "documentation.runs.recovery":
    "运行标记为需要恢复时，请操作员的 Agent 在运行所在计算机上调用 recover。检查上报的恢复结果和完整性发现。结果摘要仅显示最近记录时，可通过“事件”查看更早的证据。",
  "documentation.runs.next":
    "回答关卡后，让操作员的 Agent 继续。恢复尚未完成时，请先与操作员一起检查证据，再决定后续处理。",
  "documentation.evaluations.purpose":
    "“评估”认证已组装的软件包，并保留绑定其确切哈希的报告。较早软件包的通过报告不能作为当前软件包的发布依据。",
  "documentation.evaluations.roles":
    "工程师和管理员启动评估。工作流读者查看其有权访问的报告；工作流负责人在审核发布时使用当前通过的证据。",
  "documentation.evaluations.start":
    "选择工作流和版本，检查当前组装的软件包，然后“开始评估”。确认对话框会说明受限认证任务、绝不执行领域脚本以及报告将被保留。确认后跟进进度，或等待收件箱通知完成再返回查看。",
  "documentation.evaluations.report":
    "打开报告审阅软件包检查、创作交叉验证、认证阶段及反例、耗时与产物凭据。比较报告哈希与当前软件包，处理阻碍后再对更改后的内容评估。",
  "documentation.evaluations.next":
    "当前哈希评估通过后，返回“工作流 → 审核与发布”，由工作流负责人明确确认批准和发布。",
  "documentation.activity.purpose":
    "“活动”以仅追加方式记录谁在何时，通过何种渠道，针对哪个目标，出于什么原因执行了操作。用于审核与调查，不用于编辑历史。",
  "documentation.activity.roles":
    "管理员和审计员可查看组织的完整活动日志。其他工作的访问仍由各自角色控制；阅读事件不会授予修改权限。",
  "documentation.activity.filter":
    "使用操作者、操作、目标与时间筛选，点击“应用筛选”缩小事件范围。存在目标链接时可打开，并对照当前记录与历史。",
  "documentation.activity.reason":
    "调查被阻止或已变更的操作时，阅读已记录的确认证据与管理员覆盖原因。日志保留原始操作者和事件，无法在此重写。",
  "documentation.activity.next":
    "跟进相关工作流、问题或运行，请责任人通过正常的审阅操作解决问题。",
  "documentation.admin.purpose":
    "“管理”包含成员、团队、邀请和集成，用于管理工作流团队背后的人员与权限，不能替代工作流本身的签署确认。",
  "documentation.admin.roles":
    "管理员管理组织权限与团队。团队负责人管理自己负责及权限范围内的嵌套团队。审计员只读，不更改记录；管理员和审计员可查看集成状态。",
  "documentation.admin.members":
    "检查成员及角色绑定。在“团队”中创建或打开团队、审阅成员，并在允许的范围内分配或移除角色。团队绑定适用于嵌套团队；工作流绑定仅适用于该工作流及其版本。",
  "documentation.admin.invitations":
    "通过“邀请”按可验证的邮箱身份邀请人员担任角色、查看待处理邀请或重新发送。审阅移除确认。管理员覆盖被拒绝的操作时，必须填写原因；活动日志会记录该原因。",
  "documentation.admin.integrations":
    "通过“集成”检查服务已配置的连接与状态。属于部署层的配置由部署管理员在仪表盘外管理。演示模式不提供管理操作。",
  "documentation.admin.next":
    "返回工作流团队检查角色分配，或请新成员使用受邀且已验证的邮箱登录并打开“我的工作”。",
  "documentation.settings.purpose":
    "“个人设置”控制您的外观、语言、通知偏好、个人访问令牌与投递渠道。外观和语言仅影响您，不会改变他人设置或改写记录内容。",
  "documentation.settings.roles":
    "每位已登录人员管理自己的偏好与令牌。令牌受本人角色与所选 MCP 配置限制。工作流通知渠道还需仪表盘所示的管理权限。",
  "documentation.settings.preferences":
    "选择浅色、深色或跟随系统，调整字号或折叠导航。在此或顶部“语言”中选择 English 或中文。检查已保存或失败状态；保存失败时，更改仅在本地生效，直到保存成功。演示模式仅可在本次访问中调整外观与语言。",
  "documentation.settings.tokens":
    "在“个人访问令牌”中选择 Agent 所需权限，审阅创建操作，并复制仅展示一次的秘密值。妥善保管并撤销不用的令牌。按 MCP 配置说明连接 Agent 主机；令牌可在其权限内起草，但不能替您批准或回答关卡。",
  "documentation.settings.notifications":
    "选择通知事件、设置自己的提醒身份，并管理有权配置的群机器人渠道。通过投递历史调查通知失败，不要分享 webhook 秘密值。",
  "documentation.settings.next":
    "返回“我的工作”或工作流，确认 Agent 使用了预期的配置，重要请求能够送达您选择的通知渠道。",
};
