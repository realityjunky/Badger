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
  "documentation.steps": "Setup steps",
  "documentation.resources": "Related links",
  "documentation.nodeDownload": "Download Node.js LTS",
  "documentation.wecom-cli.title": "WeCom CLI installation",
  "documentation.wecom-cli.purpose":
    "Install WeCom CLI on your own macOS or Windows laptop to let an Agent work with your WeCom account. WorkBuddy also offers a built-in route: open Connectors, add WeCom, and scan the QR code to create and authorize a robot. For a terminal installation, follow the steps below. Badger notifications use the separately configured My WeCom robots connection.",
  "documentation.wecom-cli.roles":
    "Each person installs and authorizes their own client using their own WeCom account. Your organization's administrator may need to approve access to some WeCom capabilities.",
  "documentation.wecom-cli.step.prepare":
    "Prepare your laptop. Install Node.js LTS from the download link below if needed; it includes npm and npx. Open Terminal on macOS or PowerShell on Windows and check that all three commands work. Node.js 22 or newer also supports the Badger MCP setup guide.",
  "documentation.wecom-cli.step.robot":
    "For the terminal route, create an API-mode robot with a long connection in WeCom and keep its Bot ID and Secret available locally. The official guide below explains robot setup. Enter credentials only in the local authorization flow.",
  "documentation.wecom-cli.step.install":
    "Install the official CLI, then check its version. If it is already installed, check the version first and upgrade when needed. The current Agent skills require version 1.2.1 or newer.",
  "documentation.wecom-cli.step.skills":
    "Install the official CLI skills. Select your Agent host if prompted, then reopen the Agent so it discovers the skills. This is a required step in WeCom's terminal installation guide.",
  "documentation.wecom-cli.step.authorize":
    "Initialize authorization once. Follow the terminal prompts to configure the robot and complete the WeCom scan and authorization flow. Keep that terminal open until the command finishes.",
  "documentation.wecom-cli.step.verify":
    "Check authorization. Continue when the status is authorized, then ask your Agent to read your own profile as a first check. If the status is unauthorized, complete authorization again; requests needing administrator approval must wait for that approval.",
  "documentation.wecom-cli.step.agent":
    "Alternative to the terminal installation: give your Agent the command below and ask it to install the official WeCom integration. Continue the conversation so it installs the CLI and guides you through scanning and authorization. Choose this route or the terminal steps above.",
  "documentation.wecom-cli.next":
    "Use WeCom from your Agent, or open My WeCom robots in Badger to set up personal notifications. Installing WeCom CLI does not configure Badger MCP; use the separate Badger MCP setup guide to connect your Agent to Badger.",
  "documentation.wecom-cli.official": "Official WeCom CLI installation guide",
  "documentation.wecom-cli.overview":
    "WeCom capabilities overview (original help link)",
  "documentation.mcp.title": "Badger MCP setup",
  "documentation.mcp.purpose":
    "Connect WorkBuddy or a terminal Agent such as Claude Code or Codex to this Badger deployment. Install the local Badger MCP on the same computer as your Agent. The Agent starts it automatically over stdio; the setup panel generates the deployment-specific configuration.",
  "documentation.mcp.roles":
    "Each person creates their own personal access token. Choose expert for assigned questions, engineer for drafting jobs, or operator for published workflow Runs, according to your Badger roles. Token scopes and the selected work profile limit the Agent's tools; sign-offs stay in the dashboard.",
  "documentation.mcp.step.prepare":
    "Prepare the computer where WorkBuddy or your CLI Agent runs. Install Node.js 22 or newer and npm, and obtain a Badger repository checkout from your team. Check the commands below in Terminal or PowerShell.",
  "documentation.mcp.step.install":
    "Open the Badger checkout's root directory and run these commands in order. They install dependencies, build the local tools, and make badger-mcp available. Keep the checkout in place: the linked command uses its built files. On Windows, use the built cli.js path in the later configuration step.",
  "documentation.mcp.step.token":
    "In Badger, open Personal settings → Personal access tokens. Create a token with the scopes your work needs, review creation, and copy the secret shown once. Keep the secret locally for the next step.",
  "documentation.mcp.step.posix":
    "On macOS or Linux, use Bash or zsh. Run the first line below, paste your token while input is hidden, and press Enter; then run the second line. This sets BADGER_TOKEN for the current shell. Windows users use the next step instead.",
  "documentation.mcp.step.windows":
    "On Windows, use PowerShell and run the lines below. Paste your token at the masked prompt. This sets BADGER_TOKEN for the current shell. macOS and Linux users can skip this step.",
  "documentation.mcp.step.configure":
    "Return to Personal access tokens and expand Connect your Agent. Select your work profile, Agent host, and operating system, then Copy configuration. On macOS/Linux, choose badger-mcp or its absolute executable path. On Windows, enter the absolute path to packages/mcp/dist/src/cli.js inside your checkout; the generated entry starts node directly. Keep the generated deployment URL, including its base path, and token environment reference.",
  "documentation.mcp.step.workbuddy":
    "For WorkBuddy, select WorkBuddy in the setup panel and merge the generated JSON into .mcp.json at the root of the project you open in WorkBuddy, or ~/.codebuddy/.mcp.json for your user account. Preserve other MCP servers. Fully quit WorkBuddy, then start its installed executable from the terminal holding BADGER_TOKEN; an already running app or a desktop launcher may not inherit it. Open that project and enable or reload the Badger server in MCP settings.",
  "documentation.mcp.step.cli":
    "For a CLI Agent, select that exact host in the setup panel. Claude Code uses project .mcp.json or user ~/.claude.json; merge the generated mcpServers entry. Codex uses project .codex/config.toml or user ~/.codex/config.toml; merge its generated TOML, including env_vars forwarding BADGER_TOKEN, and trust the project when using project configuration. Start claude or codex from the terminal holding the token and open the intended project.",
  "documentation.mcp.step.verify":
    "In the Agent, ask: Use Badger whoami to check my identity and scopes, then read my Badger inbox. Confirm the expected person and deployment. If the MCP command is missing, check its absolute path and Node installation. For 401, check the token and deployment URL; for 403, check your workflow role, token scopes, and work profile. A terminal can remain silent when badger-mcp is started directly because it waits for the Agent's stdio protocol.",
  "documentation.mcp.next":
    "Keep the token available in the environment that launches your Agent on later visits. For an Engineer's drafting job, copy its Agent prompt from Questionnaire; for a Field expert, use the shared suggestions page to review and save edits. Confirming, approving, publishing, and answering Run gates happen in Badger.",
  "documentation.mcp.workbuddyDocs": "CodeBuddy / WorkBuddy MCP configuration",
  "documentation.mcp.claudeDocs": "Official Claude Code MCP documentation",
  "documentation.mcp.codexDocs": "Official Codex MCP documentation",
  "documentation.notifications.title": "Badger event items",
  "documentation.notifications.purpose":
    "These are the kinds of inbox items used by Notifications and Add route. An event describes what needs attention; it does not perform or approve the action. Open the item in Badger to review its evidence and act with your role. Approval requested includes confirmation and Run gates as well as approvals. Reading a notification does not complete the work.",
  "documentation.next": "Next step",
  "documentation.administration": "Administration",
  "documentation.my-work.purpose":
    "My work brings together the work waiting for you: assigned Questions, restatements to acknowledge, and confirmations or Run gates that need your attention.",
  "documentation.my-work.roles":
    "Each signed-in person sees their own inbox and the workflows their roles allow them to read. Opening an inbox item does not grant permission to act on its target.",
  "documentation.my-work.inbox":
    "Open an inbox item to reach its Question, Workflow version, or Run. Mark items read or unread to keep track of what you have reviewed. Combine the inbox's authorized Workflow, date, and status filters; multiple choices within a filter include any selected value. Dates use the message's creation time, include both selected days in your local time, and apply across all pages. Done is set automatically when the related work closes. Clear filters to return to all messages; the bell and My work counts always cover your whole inbox.",
  "documentation.my-work.scope":
    "Use the Group, Workflow, and version selectors to narrow your work, or use Search to find a workflow, Question, or Skill. The bell opens your inbox from any page.",
  "documentation.my-work.next":
    "Follow the item to its evidence, review what changed, and use the action offered for your role. Return to My work to find the next item.",
  "documentation.workflows.purpose":
    "Workflows holds the workflow frame, team, and version history. Select a Workflow version, then use full-width tabs for its sources, Source study, dossier, plan, proposal, package, review and publication, team, and notifications. Existing links and browser Back select the appropriate tab; visited tabs keep local edits. Uploading a Skill to a Group's library only makes a source available; it does not pin it, study it, answer a Question, or confirm any stage.",
  "documentation.workflows.roles":
    "Group leads and Administrators create workflows; Workflow owners also edit their workflow and assign its team. Each workflow can have one Engineer, including a pending invitation; remove the existing assignment before replacing it. Engineers pin sources, confirm Sources, complete Source study, and build and evaluate packages. Workflow owners approve dossiers, plans, proposals, and packages and confirm publication. Administrators can perform these actions. Other readers inspect the records their roles permit.",
  "documentation.workflows.sources":
    "1. Sources: choose a Skill from the workflow's Group library and pin one immutable version hash. Review the source check and explicitly confirm the source set. Changing pins invalidates this confirmation and requires a fresh check.",
  "documentation.workflows.study":
    "2. Source study: study each pinned Skill's purpose, inputs, outputs, limitations, and open questions as source-derived Facts with immutable line evidence. Review suggested script effects with the original uploader, who personally confirms the declarations. The Engineer confirms that exact version as studied when its current requirements are complete. Compare interfaces between Skills later in Questionnaire; an upload or pin alone does not complete study.",
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
    "Questionnaire collects the workflow knowledge needed to build a package. Select a workflow and version, then use the full-width Rounds and questions, Drafting jobs and suggestions, or Ledger and readiness tab. Suggestion review is available to Engineers, Field experts, and Administrators. In Rounds and questions, hide the rounds list when you need more reading space; Evidence and history opens a drawer for the selected Question or Concern, with an expanded-width option. Switching tabs keeps your selection, search, unfinished edits, and scroll position.",
  "documentation.questionnaire.roles":
    "Engineers compose and publish Questions and Rounds, resolve Answers, and confirm Facts. They also request drafting jobs and accept or discard the Agent's suggestions. Engineers and Field experts can edit and save shared suggestions before the Engineer decides. Assigned people answer Questions; Field experts acknowledge or dispute Facts restated from their Answers and can raise Concerns. Workflow roles other than Observer can comment. Observers and Auditors read without changing records.",
  "documentation.questionnaire.answer":
    "Read the Question, its reason, requested answer format, and evidence before saving an Answer. Use the thread for discussion and attach synthetic examples when useful. Answer revisions retain their history.",
  "documentation.questionnaire.resolve":
    "The Engineer reviews an Answer and records a Resolution: confirm it, ask a follow-up, defer with a reason, or withdraw. A confirmed Fact restating an expert's Answer still needs that expert's acknowledgement; a dispute reopens the Question.",
  "documentation.questionnaire.ledger":
    "Inspect the Ledger's confirmed user Facts, source-derived Facts, Inferences, unresolved Assumptions, and remaining Questions. Review an Agent's drafting result before accepting it; an unaccepted draft is not an agreed Fact.",
  "documentation.questionnaire.drafting.scenario":
    "Drafting jobs and suggestions: request an Agent's first pass from pinned evidence and submitted records. By default, the status filter shows Queued, Claimed, and Awaiting your review; choose other statuses beside Reload records to find accepted, discarded, or cancelled jobs. Right-click a job card's body to copy its link; opening it reveals that job for an authorized reader. The info icon beside the panel title explains the review handoff. Changed inputs cancel affected jobs.",
  "documentation.questionnaire.drafting.work":
    "Request drafting offers six kinds. Draft questions and Draft follow-ups propose questions for a selected draft round; follow-ups may name a parent Question. Study a source Skill drafts source-derived Facts and script-effect suggestions for one pinned Skill. Restate an answer as facts uses submitted Answers. Translate a question uses the selected Question and explicit target language. Import a Skill's open questions needs a pinned Skill and draft round. Create the round first when required. Generated narrative uses the selected Workflow version's locale, or the translation target; your interface language does not translate stored drafts.",
  "documentation.questionnaire.drafting.review":
    "Review suggestions: Engineers and Field experts edit shared drafts, then Save. Source studies have Statements and Script effect review tabs, each with numbered item tabs. Edit statements, effect labels, rationale, conditional behavior, and uncertainty; paths and citations remain fixed. Save retains the original submission and advances the revision. Concurrent stale saves conflict: preserve your local text, reopen, and reconcile. Saving does not accept records or confirm script declarations. The Engineer separately uses Review decisions for the latest saved result; another save invalidates an older preview. Accepted questions still need round publication, restatements need the answering person's acknowledgement, and effects need the original uploader's confirmation. Discarding requires a reason and confirmation.",
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
    "Review the inventory and exact hash, then use Confirm immutable upload (or Confirm immutable import). Uploads need no declarations or model connection. For versions with scripts, the Engineer's Agent drafts effects during Source study; the original uploader corrects rows, answers uncertainties, and personally confirms the complete set. The same entry/version's confirmation is reusable; corrections append history and reopen dependent work without changing files.",
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
    "If the source inventory contains no scripts, there is nothing to declare. No uploader effect task is required; confirm the immutable upload and complete Source study's other checks without adding artificial declarations.",
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
    "Open Activity under Administration in the sidebar. It is the append-only record of who acted, when, on what target, through which channel, and with what reason. Use it for review and investigation; its navigation location does not change access permissions.",
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
    "Choose Light, Dark, or System, adjust text size, or collapse navigation. Select English or 中文 here or with Language in the top bar. This changes menus and built-in help; drafted records use their Workflow version's locale, and saved text keeps its language. Check the saved or failed status; a failed save only applies locally until it succeeds. In demo mode only appearance and language are available for this visit.",
  "documentation.settings.tokens":
    "In Personal access tokens, select the scopes your Agent needs, review creation, and copy the secret when shown once. Keep it private and revoke unused tokens. Use the MCP setup instructions for your Agent host; a token can draft within its scopes but cannot approve or answer gates for you.",
  "documentation.settings.chatModes":
    "You can use personal and group chats together. For reusable personal delivery, create a long-connection robot in WeCom, register its Bot ID and Secret in My WeCom robots, verify your personal chat, and add routes. The workflow or Group channel editor also retains a direct Long connection · personal chat option for one channel; it does not target a group chat. For a shared WeCom group chat, create a group robot in that chat and copy its webhook URL. A Workflow owner connects it in the workflow's Notifications and reminders by choosing Group robot webhook; a Group lead or Administrator can instead set a Group robot default under Channel addresses. These are separate Badger connections. A Group scope in a personal route filters Badger work; its destination remains your personal chat.",
  "documentation.settings.notifications":
    "In Notifications, choose which events may reach you through personal robot routes and shared chat mentions. Turning an event off suppresses both; your Badger inbox still receives the item. In My WeCom robots, register and verify a personal robot, then add routes choosing an event, scope, and destination. See Badger event items below for every event's meaning. Use delivery history to investigate failures.",
  "documentation.settings.channels":
    "Channel addresses supplies your WeCom userid or mobile for @mentions in shared webhook chats. Badger prefers userid, then mobile, and otherwise lists your name. Group leads and Administrators also manage Group robot defaults on this tab; a workflow's own channel overrides its inherited default. My WeCom robots uses each robot's separately saved and verified userid, so Channel addresses is optional for personal delivery and does not register or verify a robot. Personal routes and shared channels operate independently: both can send the same event. Badger inbox only stops that personal route's post; it does not disconnect a shared channel.",
  "documentation.settings.next":
    "Return to My work or your workflow. Confirm that your Agent uses the intended profile and that important requests reach your chosen notification channel.",
  "documentation.settings.robots.purpose":
    "My WeCom robots are personal notification endpoints. Badger stores the Bot ID and Secret encrypted, keeps the long connection in its worker, and never gives a robot Badger permissions. The optional wecom-cli is a separate assistant client; install it only if you want to use WeCom from your own computer.",
  "documentation.settings.robots.step.wecom":
    "1. Create a WeCom long-connection robot and copy its Bot ID and Secret. For the optional laptop client, open WeCom CLI installation in this guide's menu for numbered steps and the official help links. CLI authorization and the credentials you enter in Badger are configured separately.",
  "documentation.settings.robots.step.userid":
    "2. Find your WeCom userid before opening Badger. In WeCom, ask 智能助理大圆 (Smart Assistant Dayuan), “我的 userid 是什么？”, and copy the exact userid it returns. Use that userid, not your display name, mobile number, Bot ID, or Secret.",
  "documentation.settings.robots.step.register":
    "3. Open Personal settings → My WeCom robots, choose Add personal robot, and enter a label, Bot ID, Secret, and the userid from the previous step. Save the robot. Badger masks the credentials after saving.",
  "documentation.settings.robots.step.verify":
    "4. On the robot card, choose Verify personal chat. Open a one-to-one chat with the robot in WeCom and send the exact one-time `link ...` command. Wait until the card says Chat verified and Connected.",
  "documentation.settings.robots.step.route":
    "5. In Notification routes, choose Add route. Select one or more Badger events, scope (All my work, a Group, or a Workflow), and this robot as the destination. Badger creates one route for each selected event. Scope filters Badger work; choosing Group does not send to a WeCom group chat. Choose Badger inbox only to suppress the matching personal posts; separately configured shared channels are unaffected.",
  "documentation.settings.robots.step.test":
    "6. Choose Test on the verified robot, confirm the message arrives in your personal WeCom chat, and then trigger a matching Badger event. Use the Delivery log when you need to inspect a queued, sent, retried, or failed post.",
  "documentation.settings.robots.next":
    "Start with one low-risk event such as Approval requested for All my work. Confirm the test post and the first real notification before adding more routes. Workflow scope overrides Group scope, and Group scope overrides All my work.",
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
  "documentation.steps": "设置步骤",
  "documentation.resources": "相关链接",
  "documentation.nodeDownload": "下载 Node.js LTS",
  "documentation.wecom-cli.title": "企业微信 CLI 安装",
  "documentation.wecom-cli.purpose":
    "在自己的 macOS 或 Windows 笔记本上安装企业微信 CLI，让 Agent 使用您的企业微信账号。WorkBuddy 也提供内置入口：打开“连接器”，添加“企业微信”，扫码创建并授权机器人。终端安装请按以下步骤操作。Badger 通知通过单独配置的“我的企业微信机器人”连接发送。",
  "documentation.wecom-cli.roles":
    "每个人使用自己的企业微信账号安装并授权个人客户端。某些企业微信能力可能需要组织管理员批准后才能使用。",
  "documentation.wecom-cli.step.prepare":
    "准备笔记本环境。需要时通过下方链接安装 Node.js LTS，其中包含 npm 和 npx。macOS 打开终端，Windows 打开 PowerShell，检查以下三个命令均可运行。Node.js 22 或更新版本也适用于 Badger MCP 设置指南。",
  "documentation.wecom-cli.step.robot":
    "使用终端方式时，先在企业微信创建 API 模式的长连接机器人，并在本机备好 Bot ID 和 Secret。下方官方指南说明了创建方式。仅在本机授权流程中输入凭据。",
  "documentation.wecom-cli.step.install":
    "安装官方 CLI 并检查版本。已安装时先检查版本，需要时再升级。当前 Agent 技能要求版本不低于 1.2.1。",
  "documentation.wecom-cli.step.skills":
    "安装官方 CLI 技能。若提示选择宿主，请选中您的 Agent，随后重新打开 Agent 以加载技能。这是企业微信官方终端安装指南中的必需步骤。",
  "documentation.wecom-cli.step.authorize":
    "首次使用时初始化授权。按终端提示配置机器人，完成企业微信扫码及授权流程。命令结束前请保持该终端打开。",
  "documentation.wecom-cli.step.verify":
    "检查授权状态。显示 authorized 后继续，并先让 Agent 读取您自己的身份信息进行验证。显示 unauthorized 时请重新完成授权；需要管理员批准的能力须等待审批通过。",
  "documentation.wecom-cli.step.agent":
    "终端安装的替代方式：把下方命令提供给 Agent，让它安装官方企业微信集成。继续对话，由 Agent 安装 CLI 并引导扫码授权。选择此方式或上方终端步骤之一即可。",
  "documentation.wecom-cli.next":
    "在 Agent 中使用企业微信，或进入 Badger 的“我的企业微信机器人”配置个人通知。安装企业微信 CLI 不会配置 Badger MCP；连接 Agent 与 Badger 请参阅单独的“Badger MCP 设置”指南。",
  "documentation.wecom-cli.official": "企业微信 CLI 官方安装指南",
  "documentation.wecom-cli.overview": "企业微信开放能力总览（原帮助链接）",
  "documentation.mcp.title": "Badger MCP 设置",
  "documentation.mcp.purpose":
    "将 WorkBuddy 或 Claude Code、Codex 等终端 Agent 连接到此 Badger 部署。在运行 Agent 的同一台电脑上安装本地 Badger MCP。Agent 会通过 stdio 自动启动它；设置面板会生成此部署专用的配置。",
  "documentation.mcp.roles":
    "每个人创建自己的个人访问令牌。按 Badger 角色选择范围：expert 用于已分配的问题，engineer 用于起草任务，operator 用于运行已发布工作流。令牌范围和工作配置限制 Agent 可使用的工具；签署确认在仪表盘中完成。",
  "documentation.mcp.step.prepare":
    "准备运行 WorkBuddy 或终端 Agent 的电脑。安装 Node.js 22 或更新版本及 npm，并从团队获取 Badger 仓库副本。在终端或 PowerShell 中检查以下命令。",
  "documentation.mcp.step.install":
    "进入 Badger 仓库根目录，依次执行以下命令以安装依赖、构建本地工具并注册 badger-mcp 命令。请保留仓库目录，链接命令会使用其中的构建文件。Windows 后续配置使用构建生成的 cli.js 路径。",
  "documentation.mcp.step.token":
    "在 Badger 打开“个人设置 → 个人访问令牌”，选择工作所需的范围，审阅后创建令牌，并复制仅显示一次的密钥。将密钥保留在本机，用于下一步。",
  "documentation.mcp.step.posix":
    "macOS 或 Linux 使用 Bash 或 zsh。先执行下方第一行，在隐藏输入时粘贴令牌并按回车，再执行第二行，将 BADGER_TOKEN 设置到当前 shell。Windows 用户改用下一步。",
  "documentation.mcp.step.windows":
    "Windows 使用 PowerShell 执行以下命令，在掩码提示中粘贴令牌，将 BADGER_TOKEN 设置到当前 shell。macOS 和 Linux 用户可跳过此步。",
  "documentation.mcp.step.configure":
    "回到“个人访问令牌”，展开“连接你的 Agent”，选择工作配置、Agent 宿主和操作系统，然后“复制配置”。macOS/Linux 选择 badger-mcp 或其可执行文件绝对路径；Windows 输入仓库内 packages/mcp/dist/src/cli.js 的绝对路径，生成的配置会直接启动 node。保留生成的完整部署地址（包括基础路径）和令牌环境变量引用。",
  "documentation.mcp.step.workbuddy":
    "WorkBuddy 用户在设置面板选择 WorkBuddy，将生成的 JSON 合并到 WorkBuddy 所打开项目根目录的 .mcp.json，或用户级 ~/.codebuddy/.mcp.json，保留其他 MCP 服务器。完全退出 WorkBuddy，再从设置了 BADGER_TOKEN 的终端启动其已安装的可执行程序；已运行的应用或桌面启动器可能不会继承该变量。打开对应项目，并在 MCP 设置中启用或重新加载 Badger 服务器。",
  "documentation.mcp.step.cli":
    "终端 Agent 用户在设置面板选择实际使用的宿主。Claude Code 使用项目级 .mcp.json 或用户级 ~/.claude.json，合并生成的 mcpServers 项；Codex 使用项目级 .codex/config.toml 或用户级 ~/.codex/config.toml，合并生成的 TOML（含转发 BADGER_TOKEN 的 env_vars），使用项目级配置时信任该项目。从设置了令牌的终端启动 claude 或 codex，并打开目标项目。",
  "documentation.mcp.step.verify":
    "在 Agent 中请求：使用 Badger whoami 检查我的身份和范围，然后读取我的 Badger 收件箱。核对身份与部署。找不到 MCP 命令时检查其绝对路径和 Node 安装；401 时检查令牌及部署地址；403 时检查工作流角色、令牌范围和工作配置。直接运行 badger-mcp 时终端可能保持安静，因为它在等待 Agent 的 stdio 协议。",
  "documentation.mcp.next":
    "后续每次使用时，确保启动 Agent 的环境中仍有令牌。工程师可从问卷复制起草任务的 Agent 提示词；领域专家可通过共享建议页面审核并保存修改。确认、批准、发布及回答运行关卡仍在 Badger 中完成。",
  "documentation.mcp.workbuddyDocs": "CodeBuddy / WorkBuddy MCP 配置说明",
  "documentation.mcp.claudeDocs": "Claude Code MCP 官方文档",
  "documentation.mcp.codexDocs": "Codex MCP 官方文档",
  "documentation.notifications.title": "Badger 事件事项",
  "documentation.notifications.purpose":
    "这些是“通知”和“添加路由”所使用的收件箱事项类型。事件说明什么需要处理，不会代您执行或批准操作。请在 Badger 中打开事项、审阅证据，并按自己的角色处理。“等待审批”也包括确认关卡和运行关卡。阅读通知不等于完成待办。",
  "documentation.next": "下一步",
  "documentation.administration": "管理",
  "documentation.my-work.purpose":
    "“我的工作”汇总等待您处理的事项：分配给您的问题、需要认可的事实重述，以及待确认事项或运行关卡。",
  "documentation.my-work.roles":
    "每位已登录人员查看自己的收件箱，以及其角色允许读取的工作流。打开消息不会授予处理该事项的权限。",
  "documentation.my-work.inbox":
    "打开收件箱消息可进入对应的问题、工作流版本或运行。使用已读和未读标记跟踪已审阅的内容。可组合收件箱的已授权工作流、日期和状态筛选；同一筛选中选择多项时，符合任意一项即可。日期按消息创建时间筛选，使用您的本地时间，包含开始和结束当天，并应用于所有分页。相关事项结束后会自动标为已完成。清除筛选可返回全部消息；铃铛和“我的工作”的计数始终涵盖整个收件箱。",
  "documentation.my-work.scope":
    "使用团队、工作流和版本选择器缩小范围，或通过搜索查找工作流、问题或 Skill。可从任意页面的铃铛打开收件箱。",
  "documentation.my-work.next":
    "跟随消息查看证据，审阅变更，并使用您的角色可执行的操作。返回“我的工作”继续处理下一项。",
  "documentation.workflows.purpose":
    "“工作流”管理工作流框架、团队和版本历史。选择工作流版本后，可通过全宽选项卡查看来源、来源研读、档案、计划、提案、软件包、审核与发布、团队和通知。原有链接和浏览器后退会切换至相应选项卡，已访问的选项卡会保留本地编辑。将 Skill 上传到团队库仅使来源可用，不会自动固定版本、完成研读、回答问题或确认任何阶段。",
  "documentation.workflows.roles":
    "团队负责人和管理员创建工作流；工作流负责人也可编辑自己的工作流并分配团队角色。每个工作流只能分配一名工程师，待接受的邀请也占用名额；替换前请先移除现有分配。工程师固定来源、确认来源、完成来源研读，并构建和评估软件包。工作流负责人批准语义档案、计划、提案和软件包，并确认发布。管理员可以执行这些操作。其他读者查看其角色允许访问的记录。",
  "documentation.workflows.sources":
    "1. 来源：从工作流所属团队的库中选择 Skill，固定一个不可变版本的哈希。审阅来源检查并明确确认来源集合。更改固定版本会使本次确认失效，必须重新检查。",
  "documentation.workflows.study":
    "2. 来源研读：逐个研读固定 Skill 的用途、输入、输出、限制与未决问题，记录带有不可变行号证据的来源事实。与原上传者审核脚本副作用建议，由原上传者亲自确认声明。当前要求全部完成后，工程师确认该确切版本已研读。Skill 之间的接口比较放在后续问卷阶段；仅上传或固定版本不等于完成研读。",
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
    "“问卷”收集构建软件包所需的工作流知识。选择工作流与版本，再使用占满内容区宽度的“轮次与问题”“起草任务与建议”或“台账与就绪状态”选项卡。工程师、领域专家和管理员均可审核建议。在“轮次与问题”中，可隐藏轮次列表以扩大阅读空间；“证据与历史”会打开当前问题或关注事项的抽屉，并可展开至全宽。切换选项卡会保留所选记录、搜索、未完成的编辑和滚动位置。",
  "documentation.questionnaire.roles":
    "工程师编写并发布问题和轮次、解决回答并确认事实，也可请求起草任务并接受或丢弃 Agent 的建议。工程师和领域专家可先编辑并保存共享建议，再由工程师作出决定。被分配的人员回答问题；领域专家认可或质疑从其回答重述的事实，也可提出关注事项。除观察者外的工作流角色可评论。观察者和审计员只读，不更改记录。",
  "documentation.questionnaire.answer":
    "保存回答前，阅读问题、提问原因、要求的回答格式与证据。通过讨论串交流，并在需要时附上合成示例。回答的每次修订都会保留历史。",
  "documentation.questionnaire.resolve":
    "工程师审阅回答并记录解决结果：确认、提出追问、说明原因后暂缓，或撤回。从专家回答重述的已确认事实仍需该专家认可；质疑会重新打开问题。",
  "documentation.questionnaire.ledger":
    "检查台账中的已确认用户事实、来源事实、推断、未决假设和剩余问题。接受 Agent 起草结果前先审阅；尚未接受的草稿不是已达成共识的事实。",
  "documentation.questionnaire.drafting.scenario":
    "起草任务与建议：让 Agent 依据固定证据和已提交的记录先行起草。状态筛选默认显示“排队中”“已领取”和“等待您审核”；通过“重新加载记录”旁的筛选可查找已接受、已丢弃或已取消的任务。右键点击任务卡片正文可复制链接；有权访问的人打开链接时会显示该任务。标题旁的信息图标说明审核交接流程。输入变更会取消受影响的任务。",
  "documentation.questionnaire.drafting.work":
    "“请求起草”提供六种类别。“起草问题”和“起草追问”为所选草稿轮次提出问题，追问可指定父问题；“研读来源 Skill”为单个固定的 Skill 起草来源事实和脚本副作用建议；“将回答重述为事实”使用已提交的回答；“翻译问题”使用所选问题及明确指定的目标语言；“导入 Skill 的开放问题”需要固定的 Skill 和草稿轮次。需要轮次时请先创建。生成文字使用所选工作流版本的语言或翻译目标语言；界面语言不会翻译已保存的草稿。",
  "documentation.questionnaire.drafting.review":
    "审核建议：工程师和领域专家编辑共享草稿后点击“保存”。来源研读分为“陈述”和“脚本副作用审核”两个主选项卡，各自包含编号子选项卡。可编辑陈述、副作用标签、理由、条件行为和不确定性；路径与引用保持固定。保存会保留原始提交并推进修订号；并发的过期保存会被拒绝，请保留本地文字、重新打开最新内容后协调修改。保存不等于接受记录或确认脚本声明。工程师另行通过“审核决定”处理最新保存结果；后续保存会使旧预览失效。接受的问题仍需发布轮次，重述事实仍需作答者认可，副作用仍需原上传者确认。丢弃必须说明原因并确认。",
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
    "审阅清单与精确哈希，再确认上传或导入不可变版本。上传无需声明或模型连接。对于含脚本的版本，工程师的 Agent 在来源研读时起草副作用，原上传者更正各行、回答不确定事项并亲自确认完整声明。同一条目和版本可复用确认；更正会追加历史并重新开启依赖工作，不改动文件。",
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
    "如果来源清单中没有脚本，就无需声明副作用，也不需要上传者副作用审核任务。确认不可变上传并完成来源研读的其他检查即可，不需要人为添加声明。",
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
    "从侧栏“管理”下打开“活动”。它以仅追加方式记录谁在何时，通过何种渠道，针对哪个目标，出于什么原因执行了操作，用于审核与调查；导航位置不会改变访问权限。",
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
    "选择浅色、深色或跟随系统，调整字号或折叠导航。在此或顶部“语言”中选择 English 或中文，影响菜单与内置帮助；起草记录使用工作流版本的语言，已保存文字保持原有语言。检查已保存或失败状态；保存失败时，更改仅在本地生效，直到保存成功。演示模式仅可在本次访问中调整外观与语言。",
  "documentation.settings.tokens":
    "在“个人访问令牌”中选择 Agent 所需权限，审阅创建操作，并复制仅展示一次的秘密值。妥善保管并撤销不用的令牌。按 MCP 配置说明连接 Agent 主机；令牌可在其权限内起草，但不能替您批准或回答关卡。",
  "documentation.settings.chatModes":
    "个人聊天和群聊可以同时使用。可复用的个人投递：在企业微信创建长连接机器人，在“我的企业微信机器人”中登记 Bot ID 和 Secret，验证个人聊天，再添加路由。工作流或团队的渠道编辑器还保留“长连接·个人聊天”选项，用于单个渠道；它不会指向群聊。共享企业微信群聊：在目标群中创建群机器人，复制其 webhook URL，由工作流负责人在工作流的“通知与提醒”中选择“群机器人 Webhook”并连接；团队负责人或管理员也可在“通知地址”中设置团队默认机器人。这是 Badger 中两个独立的连接。个人路由中的“团队”范围只筛选 Badger 工作，目的地仍是您的个人聊天。",
  "documentation.settings.notifications":
    "在“通知”中选择哪些事件可以通过个人机器人路由发送消息，或在共享群聊中 @ 您。关闭某事件会同时停止这两种提醒；Badger 收件箱仍会收到事项。在“我的企业微信机器人”中登记并验证个人机器人，再添加路由，选择事件、范围和目的地。下方“Badger 事件事项”解释了每类事件的含义。通过投递历史调查失败原因。",
  "documentation.settings.channels":
    "“通知地址”提供企业微信 userid 或手机号，用于共享 webhook 群聊中的 @ 提及。Badger 优先使用 userid，其次使用手机号，均未填写则仅显示姓名。团队负责人和管理员还可在此选项卡管理团队默认机器人；工作流自己的渠道优先于继承的默认渠道。“我的企业微信机器人”使用每个机器人单独保存并验证的 userid，因此个人投递无需填写“通知地址”，填写地址也不会登记或验证机器人。个人路由和共享渠道各自独立，两者均配置时，同一事件可能在两处收到。“仅 Badger 收件箱”只停止该个人路由的消息，不会断开共享渠道。",
  "documentation.settings.next":
    "返回“我的工作”或工作流，确认 Agent 使用了预期的配置，重要请求能够送达您选择的通知渠道。",
  "documentation.settings.robots.purpose":
    "“我的企业微信机器人”是个人通知目的地。Badger 会加密保存 Bot ID 和 Secret，由 worker 维护长连接，机器人不会获得 Badger 权限。可选的 wecom-cli 是独立的个人助手客户端；只有希望在自己的电脑上使用企业微信时才需要安装。",
  "documentation.settings.robots.step.wecom":
    "1. 在企业微信创建长连接方式机器人，并复制 Bot ID 和 Secret。如需可选的笔记本客户端，请在本指南菜单打开“企业微信 CLI 安装”，查看逐步操作及官方帮助链接。CLI 授权与填入 Badger 的凭据分别配置。",
  "documentation.settings.robots.step.userid":
    "2. 在打开 Badger 前获取企业微信 userid。在企业微信中询问“智能助理大圆”：“我的 userid 是什么？”，复制它返回的确切 userid。请使用 userid，不要使用显示名称、手机号、Bot ID 或 Secret。",
  "documentation.settings.robots.step.register":
    "3. 打开“个人设置 → 我的企业微信机器人”，点击“添加个人机器人”，填写标签、Bot ID、Secret 和上一步获取的 userid。保存后，Badger 会隐藏凭据。",
  "documentation.settings.robots.step.verify":
    "4. 在机器人卡片中点击“验证个人聊天”。在企业微信中打开与机器人的单聊，并发送完整的一次性 `link ...` 命令。等待卡片显示“个人聊天已验证”和“已连接”。",
  "documentation.settings.robots.step.route":
    "5. 在“通知路由”中点击“添加路由”。选择一个或多个 Badger 事件、范围（我的全部工作、团队或工作流）以及这个机器人作为目的地。Badger 会为每个所选事件创建一条路由。范围只筛选 Badger 工作；选择“团队”不会向企业微信群聊发送消息。选择“仅 Badger 收件箱”可停止匹配的个人消息；单独配置的共享渠道不受影响。",
  "documentation.settings.robots.step.test":
    "6. 在已验证的机器人上点击“发送测试”，确认个人企业微信聊天收到消息，然后触发匹配的 Badger 事件。需要检查排队、已发送、重试或失败消息时，查看投递日志。",
  "documentation.settings.robots.next":
    "先为“我的全部工作”配置一个低风险事件，例如“等待审批”。确认测试消息和第一条真实通知都能收到，再增加其他路由。工作流范围优先于团队范围，团队范围优先于我的全部工作。",
};
