# Self-hosted CI

Badger uses GitHub Actions with repository-scoped self-hosted runners. Runner
compute does not consume GitHub-hosted compute allowances. Hardware,
maintenance, and any storage beyond GitHub's included allowances remain the
operator's responsibility. There is no GitHub-hosted runner fallback.

## Jobs and runner labels

The default workflow runs on pushes to `main`, pull requests from branches in
this repository, and manual dispatches:

| Job                | Required labels                     | Checks                                 |
| ------------------ | ----------------------------------- | -------------------------------------- |
| `run-storage`      | `self-hosted`, `Linux`, `badger-ci` | Kernel build and run-storage suite     |
| `build-test`       | `self-hosted`, `Linux`, `badger-ci` | All builds, unit tests, and formatting |
| `web-e2e`          | `self-hosted`, `Linux`, `badger-ci` | Browser journeys on the runner host    |
| `service-postgres` | `self-hosted`, `Linux`, `badger-ci` | Server suite against Postgres 17       |

One Linux runner can process these jobs sequentially. Additional runners with
the same labels allow parallel jobs. Each runner needs its own installation
directory and work directory. New runs cancel superseded runs for the same
branch or pull request; each job also has an explicit timeout.

The Postgres service publishes a dynamically allocated port on `127.0.0.1`.
The test connection uses that assigned port, so CI does not claim a fixed
Postgres port on the host. GitHub manages each job's service containers and
network. The browser journeys run on the runner host, not in a container: the
job installs Chromium's headless shell, about 120 MB, into the runner
account's Playwright cache once, and later runs reuse it. They serve the
dashboard on loopback ports 4319–4323, which must be free on the host.

## Linux runner setup

Use a maintained Linux machine with Git, Bash, curl, tar, the GitHub runner's
runtime dependencies, Docker, and the system libraries Chromium needs. On
Debian or Ubuntu, an administrator installs those libraries once with
`sudo npx playwright install-deps chromium` from a checkout after `npm ci`.
Node.js 22 is installed by `actions/setup-node`; the runner needs network
access to GitHub, the npm registry, Docker Hub, and Playwright's browser
downloads from `cdn.playwright.dev` and the hosts it redirects to. Allow
outbound HTTPS; the runner does not need an inbound webhook endpoint. Behind
a proxy, set `https_proxy`, `http_proxy`, and `no_proxy` in the runner
installation's `.env`, with `localhost` and `127.0.0.1` in `no_proxy`; the
runner and its jobs on the host use them.

On a host shared with other services, create a dedicated unprivileged account
with its own home, runner installation, and rootless Docker daemon. Keep that
account outside the host's `sudo` and `docker` groups, and do not mount the
production Docker socket or personal home directories into jobs. Rootless
Docker needs `newuidmap`, `newgidmap`, and subordinate UID/GID ranges; follow
[Docker's rootless setup](https://docs.docker.com/engine/security/rootless/).
Enable the account's user service at boot with `loginctl enable-linger`.
Keep machine-specific provisioning files outside this repository.

1. Open the repository's **Settings → Actions → Runners → New self-hosted
   runner**. Select Linux and the machine's architecture. Download the
   current runner and verify the SHA-256 checksum shown there.
2. As the dedicated account, extract the runner into an empty directory.
   Run `./config.sh --url https://github.com/OWNER/REPOSITORY --labels badger-ci --work _work`,
   substituting the repository URL, and enter the short-lived registration
   token at its prompt. Keep the default `self-hosted`, `Linux`, and
   architecture labels. Do not save the token in the checkout, documentation,
   or shell history.
3. In the runner installation's `.env`, set
   `DOCKER_HOST=unix:///run/user/<runner-uid>/docker.sock`. This makes container
   jobs and service containers use that account's rootless daemon. Do not
   point it at `/var/run/docker.sock` on a shared host.
4. From the runner directory, install its system service for the dedicated
   account with `sudo ./svc.sh install <runner-account>` and start it with
   `sudo ./svc.sh start`. See
   [GitHub's service instructions](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application).
5. Confirm that GitHub lists the runner as **Idle** with the required labels.
   Confirm Docker reports `rootless` when invoked as that account with the
   configured `DOCKER_HOST`. Dispatch **CI** on the branch containing this
   workflow and verify all four Linux jobs, including Postgres and Playwright.

The workflow gives its token read-only access to repository contents and
does not leave checkout credentials in Git configuration. Fork pull requests
do not execute on these persistent runners. Review a fork contribution and
bring it onto a branch in this repository before running CI. Only give
trusted people permission to push branches that can execute here. Runner
accounts must not have deployment credentials.

## Optional Windows and macOS coverage

Linux checks run automatically. The Windows and macOS run-storage checks
are disabled until both runner types are available; Linux does not replace
that platform coverage.

Register a Windows runner and a macOS runner with the `badger-ci` label and
their default OS labels. Then enable the repository Actions variable:

```bash
gh variable set BADGER_CI_CROSS_PLATFORM --repo OWNER/REPOSITORY --body true
```

This enables `run-storage-cross-platform` for both platforms. Both jobs use
self-hosted runners. If an enabled platform has no matching online runner,
its job queues; it never switches to a billed GitHub-hosted runner. Disable
the checks again with `--body false`. If required status checks are configured,
align them with the enabled job names before changing this variable.

## Operations

Keep the runner application, operating system, and Docker updated. Monitor
disk space in the runner work directory and the account's rootless Docker
data. Persistent runners retain files, images, and the Playwright browser
cache between jobs. `npm ci` reinstalls project dependencies, and checkout
cleans the working tree, but neither resets the whole machine. Prune unused
Docker images only on the runner account's daemon, while the runner is idle.

If jobs queue, check the runner's online state, labels, service logs, and
outbound network access. If service containers fail to start, verify
`DOCKER_HOST` and the rootless Docker user service. A failed browser run
uploads its Playwright report for seven days; artifact and cache storage
still have GitHub allowances.

To retire a runner, stop and uninstall its runner service, remove its
registration in GitHub, and then retire the account's rootless Docker user
service and storage. Do not remove a runner while it is processing a job.
