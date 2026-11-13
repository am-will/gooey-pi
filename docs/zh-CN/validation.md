# 验证指南

本页说明如何复现和解读 GooeyPi 的验证闸门。它不是状态报告。某条命令或工作流通过，只能证明产生该结果的确切提交、运行器、输入和凭据；不要根据本文推断当前分支已通过。

## 受保护的 `main` 验证契约

仓库的 `main` 分支保护必须要求拉取请求，并要求状态检查在启用 **Require branches to be up to date before merging** 的情况下通过（`required_status_checks.strict: true`）。这种严格的“最新 main”要求可防止 PR 在比 CI 验证过的集成状态更新的基线上合并。

必需检查恰好是以下七个常规拉取请求闸门：

- `Production dependency audit`
- `quality`
- `hermetic-e2e`
- `windows-state-migration`
- `packaging-smoke (macos-14, mac, arm64, --config.mac.identity=null)`
- `packaging-smoke (ubuntu-22.04, linux, x64)`
- `packaging-smoke (windows-2022, win, x64)`

不要要求 `local-qa-package`：它属于手动本地 QA，只能通过 `workflow_dispatch` 运行，并且被有意排除在拉取请求验证之外。

`Production dependency audit` 使用 GitHub 报告的工作流作业名：它针对确切的 PR head 运行能识别例外的 `npm run audit:production` 评估器，发布工作流则在任何打包或发布作业之前，针对其验证过的不变 SHA 运行同一评估器。分支保护使用报告出来的名称，而不是内部 YAML 键 `production-audit`。计划性的[依赖审计工作流](../.github/workflows/audit.yml)仍然保留，用于处理合并后披露的公告。

当仓库由个人账户持有时，此公共仓库无法使用 GitHub 合并队列。因此，`merge_group` 或必需的合并队列无法在这里执行该策略；严格的“保持最新”分支保护是受支持的最新 main 控制手段。如果仓库迁移到组织，应在启用前单独设计和测试合并队列支持。

授权维护者可以用以下命令验证当前旧式分支保护和确切的必需上下文集合：

```sh
gh api repos/am-will/gooey-pi/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```

## 权威来源

| 关注点 | 权威定义 |
|---|---|
| 拉取请求、`main` 和手动 CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| 带标签的公开版本 | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| 计划性生产依赖审计 | [`.github/workflows/audit.yml`](../.github/workflows/audit.yml) |
| 聚合命令与工具链策略 | [`package.json`](../package.json) 与 [`.nvmrc`](../.nvmrc) |
| 解析后的依赖图 | [`package-lock.json`](../package-lock.json) |
| 依赖安装生命周期 | [`package.json`](../package.json) 与 [`install-app-deps.mjs`](../scripts/release/install-app-deps.mjs) |
| 打包及打包后保证 | [`scripts/release/package.mjs`](../scripts/release/package.mjs)、[`verify-package.mjs`](../scripts/release/verify-package.mjs) 与 [`verify-cross-platform-package.mjs`](../scripts/release/verify-cross-platform-package.mjs) |
| 审计策略与已接受风险 | [`docs/security.md`](../security.md)、[`audit-production.mjs`](../scripts/release/audit-production.mjs) 与 [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) |

请在被验证的提交上阅读这些文件。作业名、测试清单、依赖版本、预算和产物矩阵都可能变化；把它们的当前值复制进一张永久的通过/失败表，只会制造另一份过期快照。

## 可复现的环境搭建

仓库从已提交的元数据推导 Node 和 npm 策略。`package.json#engines`、`package.json#packageManager` 和 `.nvmrc` 必须一致；发布入口会拒绝不受支持、格式错误或预发布版本的工具链。使用 `nvm` 时，按以下步骤准备检出：

```bash
nvm install
nvm use
npm run toolchain:bootstrap
npm ci
npm run release:preflight:toolchain
```

在安装项目依赖之前运行 `toolchain:bootstrap`。它会把 `packageManager` 固定的 npm 安装到当前 npm 已验证的全局前缀，使用当前 Node 可执行文件验证确切的已安装 JavaScript CLI，并把匹配的 shim 目录发布给后续 GitHub Actions 步骤。这一步是必要的，因为 `actions/setup-node` 捆绑的 npm 可能低于仓库的最低 npm 版本。

`npm ci` 会运行共享的 `postinstall` 入口。该入口会同步安装 Electron 的平台运行时，然后要求 Electron Builder 重建原生依赖，从而避免并行测试 worker 与 Electron 的懒下载发生竞争。使用 `--ignore-scripts` 安装会有意跳过这两项操作；请先按[源码搭建说明](../../README.zh-CN.md#从源码运行)中的恢复步骤处理，再运行或打包应用。

不要在验证说明中硬编码当前的 Node、npm 或 Electron 版本。请记录在被测提交上实际观察到的值。

## 拉取请求与分支 CI

[CI 工作流](../.github/workflows/ci.yml)在拉取请求、推送到 `main` 和手动触发时运行。每个 Node 作业都会在 `npm ci` 之前引导仓库 npm，并在安装后执行仅检查工具链的发布预检。

| 作业 | 运行时机 | 通过意味着什么 |
|---|---|---|
| `Production dependency audit` | 拉取请求、`main`、手动触发 | 针对确切检出的提交，能识别例外的生产依赖审计通过。 |
| `quality` | 拉取请求、`main`、手动触发 | 验证 vendored harness 补丁；TypeScript 检查；配置的 lint 与格式检查；覆盖率套件与阈值；生产 bundle 构建；bundle 大小预算；覆盖率产物上传。 |
| `hermetic-e2e` | 拉取请求、`main`、手动触发 | 构建出的应用在固定的 macOS 运行器上通过 Playwright Electron 套件，不依赖开发者本地状态。失败产物在可用时会上传。 |
| `windows-state-migration` | 拉取请求、`main`、手动触发 | 状态迁移套件在真实的 `windows-2022` 运行器上通过，包括生产平台的首次安装、迁移、重启和更新路径。在其他操作系统上模拟 `platform: 'win32'` 是有用的单元覆盖，但不能替代此作业。 |
| `packaging-smoke` | 仅拉取请求 | 原生 macOS arm64、Linux x64 和 Windows x64 运行器能够构建未打包的应用目录。Linux 和 Windows 还会验证 ASAR 布局和确切的原生解包允许列表，然后使用隔离的用户数据启动打包应用，并要求其渲染器启动标记出现。这些是未签名冒烟构建，不是公开安装包。 |
| `local-qa-package` | 仅手动触发 | 原生运行器为 macOS、Linux 和 Windows 创建并验证可安装的本地 QA 产物，然后上传配置的产物集。这些产物不代表已签名或已公证的公开版本。 |

预期的跳过也是此设计的一部分：

- 在拉取请求和推送到 `main` 时，`local-qa-package` 预期会被跳过。
- 由于条件仅限拉取请求，`packaging-smoke` 在推送到 `main` 和手动触发时预期会被跳过。

上述每种 CI 触发都要求 `windows-state-migration`；不应出现跳过。

绿色的 PR 打包矩阵并不能证明 Developer ID 签名、Apple 公证/装订、Gatekeeper 接受、Authenticode 身份、安装包完整性或完整的公开产物矩阵。这些属于发布工作流。

## 本地聚合命令

开发时使用聚焦测试，然后选择与你需要作出的声明相匹配的聚合命令。[`package.json`](../package.json) 中的命令定义仍是权威。

| 命令 | 范围 |
|---|---|
| `npm run release:verify:package` | 工具链预检、vendored harness 补丁验证、typecheck、配置的代码检查、覆盖率测试、生产 bundle 和 bundle 大小闸门。不创建安装包，也不运行 Electron E2E。 |
| `npm run vendor:verify-patches` | 根据固定的产物元数据验证已安装 vendored harness 补丁契约。 |
| `npm run test:e2e:hermetic` | 针对现有 bundle 运行 Electron E2E。源码改动后请先运行 `npm run build`。 |
| `node scripts/release/smoke-packaged-app.mjs --platform PLATFORM --arch ARCH` | 使用隔离用户数据启动未打包的 Linux 或 Windows 应用，并要求渲染器启动标记出现。请使用匹配的原生运行器和现有的未打包产物。 |
| `npm run release:verify` | 上述包验证聚合命令加上 hermetic Electron E2E 套件。 |
| `npm run test:e2e` | 构建应用，然后运行 hermetic Electron E2E 套件。 |
| `npm run audit:production` | 获取 npm 的生产审计报告，并应用仓库的高危/严重公告和例外策略。需要网络访问。 |
| `npm run package:mac:local-qa` | 在 macOS 上运行 `release:verify`（包括 hermetic Electron E2E 套件），创建未签名/未公证的 DMG 与 ZIP 产物，并在 QA 模式下应用 macOS 打包后检查。 |
| `npm run package:linux:local-qa` | 在 Linux 上运行包验证聚合命令，创建配置的 Linux 产物，并在 QA 模式下验证其运行时布局。 |
| `npm run package:win:local-qa` | 在 Windows 上运行包验证聚合命令，创建配置的 Windows 产物，并在 QA 模式下验证其运行时布局。 |

打包是原生的：请在匹配的操作系统和架构上运行各平台命令。公开的 `package:mac`、`package:linux` 和 `package:win` 命令使用分发模式；macOS 和 Windows 分发检查需要其外部签名配置。成功的本地 QA 命令不得描述为公开信任检查。

## 依赖审计策略

[依赖审计工作流](../.github/workflows/audit.yml)每周及手动触发时运行。它使用仓库工具链，并针对生产依赖图执行 `npm run audit:production`。此计划性作业为 Dependabot 无法解析的 vendored 包形式提供公告覆盖。

拉取请求中的 `Production dependency audit` 作业和计划性审计都会运行连接实时注册表的评估器。普通发布脚本测试还会验证例外文件及其过期规则。在作出依赖公告相关声明时，请记录确切的审计运行和检出的提交。

项目闸门和 npm 原始输出回答的是不同问题：

- `npm audit --omit=dev` 是生产锁图的底层注册表报告。其输出和退出状态仅作诊断，并会随公告数据库变化。
- `npm run audit:production` 解析该报告，并对每条未被接受的 **high** 或 **critical** 公告失败。
- [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) 只能凭理由和到期日接受确切的公告/包组合。闸门也会对已过期的例外以及不再匹配报告的陈旧例外失败。
- 普通发布脚本测试检查例外结构和过期时间，因此已到期的接受项会在 PR CI 和每周审计中同时暴露。

因此，审计通过并不意味着生产依赖图没有已知公告：当某条公告在 [`audit-exceptions.json`](../scripts/release/audit-exceptions.json) 中被附上理由且尚未过期地接受时，闸门同样会通过。绝不要把通过的闸门表述为“零漏洞”。请阅读该文件以了解被审查提交上的已接受风险立场，并把新增或延长例外视为受[依赖固定与供应链策略](../security.md#dependency-pinning-and-supply-chain)约束的安全敏感改动。

## 公开版本验证

[发布工作流](../.github/workflows/release.yml)在语义化版本标签或指定现有标签的手动请求时运行。它首先验证标签与两个包清单都匹配，并解析到 `main` 上的提交；下游作业检出由此产生的不变提交 SHA。

| 发布作业 | 职责 |
|---|---|
| `validate` | 执行仓库工具链要求，验证标签/包版本和 `main` 祖先关系，并暴露确切的发布 SHA。 |
| `Production dependency audit` | 在任何打包作业之前，对该不变 SHA 应用能识别例外的生产依赖审计。 |
| `quality` | 为该 SHA 运行 `release:verify:package`。 |
| `hermetic-e2e` | 为该 SHA 构建并运行 Electron E2E 套件。 |
| `package` | 构建两个原生 macOS 架构。凭据预检失败即关闭；公开验证检查签名身份、应用及每个 Electron 辅助进程所需的麦克风 entitlement、每个打包应用的公证装订、Gatekeeper、产物完整性、fuses、原生布局/架构和包预算。 |
| `package-linux` | 在原生运行器上构建配置的 Linux 架构，并应用 Linux 包/运行时验证路径。 |
| `package-windows` | 在显式启用时，构建 Authenticode 签名的公开包或未签名的 beta 包。签名模式需要签名密钥以及配置的签名者 subject 和/或 thumbprint。 |
| `release-packages` | 拒绝失败的前置条件，收集已启用的平台产物，生成校验和，证明来源，并以仅限此最终作业的写权限发布或恢复 GitHub Release。 |

原生发布作业只有在同一不变 SHA 通过上游 quality 和 E2E 作业后才会传入 `--skip-verify`。该标志跳过重复的打包前测试聚合；它不会跳过 bundle 构建或平台特定的打包后验证。

公开 macOS 检查需要普通 PR CI 中不存在的 Developer ID 和公证凭据。签名 Windows 打包也取决于仓库配置和密钥。如果签名和未签名 Windows 发布模式都未启用，`package-windows` 预期会被跳过，聚合发布闸门会显式接受该跳过。在已启用的 Windows 作业中，签名和未签名构建步骤互斥，因此通常会跳过其中一个。

显式启用的未签名 Windows beta 尚未达到可信任状态，必须如此标注。普通 PR 冒烟包和手动本地 QA 产物不能替代任何需要凭据的发布检查。

## 记录证据

请把时点结果保存在 PR、发布说明或其他与提交关联的记录中，而不是用新的“当前状态”更新本指南。至少记录：

- 完整提交 SHA 以及工作树是否干净；
- 工作流运行 URL 或确切命令及退出状态；
- 运行器镜像或本地操作系统/架构，以及观察到的 Node 和 npm 版本；
- 工作流输入，以及跳过了哪些条件作业或步骤；
- 用于依赖审计声明的审计例外文件；
- 产物名称和校验和，以及每个产物是未签名、已签名、已公证、已装订还是已证明来源；
- 解读结果所需的任何失败、重跑、已接受限制或人工观察。

测试数量只应出现在与提交关联的证据中。持久的声明是已提交的聚合命令成功完成，而不是本指南记得某个更早日期恰好存在多少测试。
