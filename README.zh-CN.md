# GooeyPi

[English](README.md) | 简体中文

GooeyPi 是面向 [Pi](https://pi.dev/)、[OMP](https://github.com/can1357/oh-my-pi) 和 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 的桌面工作区。它在 macOS、Linux 和 Windows 上为这三个编码 agent 提供同一套友好界面，同时让每个 harness 继续管理自己的模型、登录信息和已保存的会话。

<img width="2234" height="1332" alt="GooeyPi 桌面工作区" src="https://github.com/user-attachments/assets/864ff0e1-71cc-49da-955f-f226710ef890" />

## 三个 harness，一个工作区

使用左上角的切换器在 Pi Work、OMP Work 和 Prime Work 之间切换。GooeyPi 会检测你电脑上安装的 harness，并显示已就绪的那些。你可以在设置中刷新检测，或指定自定义可执行文件路径。

每个 harness 都保留自己的项目、会话、模型列表、服务商可见性和正在运行的工作。切换 harness 会切换工作区，但不会停止另一个 harness 中已经运行的工作。

开始时只需安装一个 harness：

- [Pi](https://pi.dev/) 是 Pi 系列的基础编码 agent harness。
- [OMP](https://github.com/can1357/oh-my-pi) 增加了自己的插件、命令和审批控制。
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 增加了 Prime 的服务商集成和原生心跳。

## 你可以做什么

### 与 agent 协作

- 流式查看对话，支持 Markdown、推理摘要、工具活动、重试和上下文压缩。
- 选择模型、推理强度和 Fast 模式（当所选模型支持时）。
- 在 agent 工作时排队后续消息，或引导当前回合。
- 当模型支持视觉时，将 PNG、JPEG、GIF 和 WebP 图片粘贴或拖入提示词。
- 恢复、重命名、搜索、归档和还原持久会话。
- 在检查器中阅读 OMP 子 agent 历史，同时保持父对话打开。
- 在同一个“动态”视图中查看运行中、已完成、失败和等待输入的工作，并清除已处理的项目。

### 保持项目有序

- 添加本地文件夹，并按项目分组重新打开会话。
- 从侧边栏搜索项目、聊天和分支。
- 在输入框中切换关联的 Git worktree。
- 保存项目的 setup 和 run 脚本，并在集成终端中启动它们。
- 创建分支 worktree，并将其作为新的 GooeyPi 工作区打开。
- 使用 `@session` 提及另一个顶层会话、复制其 UUID，或让 agent 创建并向模型选择的会话发送消息，以进行并行工作。

### 使用内置编码工作区

- 查看 Git 状态和 diff，暂存或取消暂存文件，在确认后还原改动，并在不离开应用的情况下提交。
- 浏览项目文件，并在系统文件管理器中显示它们。
- 为会话打开多个终端标签页。高亮终端输出即可将其附加到下一条提示词。
- 随时打开右侧的摘要、改动、浏览器或文件面板。

### 带共享上下文浏览

- 使用隔离的应用内浏览器，支持地址栏、导航历史、下载和移交到外部浏览器。
- 指向页面元素并添加注释。GooeyPi 会将这些标注附加到你的下一条消息。
- 启用浏览器控制后，agent 可以打开并操作自己的标签页。你可以观察它的光标，并在需要接管时在同一标签页中操作。

### 自动化重复工作

- 为当前 harness 创建一次性或重复的定时任务。
- 选择项目或现有会话、模型、推理强度、时区和 Fast 模式。
- 立即运行定时任务、暂停或恢复它，并查看结果和运行历史。
- 当 Prime Agent 提供心跳时，可与 GooeyPi 定时任务一起管理 Prime 心跳。
- 在 macOS 上，可在**设置 → 常规**中选择在关闭窗口后继续从菜单栏运行定时任务，并可选在登录时于后台启动 GooeyPi。打包版还接受 `--background` 参数，以不打开窗口的方式启动。

### 添加功能

“功能”页面汇集了软件包、插件、扩展、skill、提示词和 MCP 服务器。GooeyPi 可以为 OMP 和启用了适配器的 Pi 管理本地 stdio MCP 定义。网络 MCP 和认证仍由所选 harness 直接控制；这些条目在 GooeyPi 中可见但为只读，并提供有边界的仅删除定义操作以便清理。当设置文件超过支持的大小时，MCP 发现会报告警告，避免无关功能遮挡受支持的 MCP 行。

GooeyPi 还附带以下可选功能：

- 让 agent 在原生对话框中向你提出一小组问题。
- 授予 agent 对应用内浏览器的受控访问权限。
- 安装独立的 CUA Driver 后，使用 TryCUA 电脑控制。

“询问用户”和电脑控制默认关闭。你可以随时在应用中启用、禁用或移除这些功能。

### 用说的代替打字

- 使用 OpenAI、Groq、Deepgram 或本地 `whisper.cpp` 安装进行提示词听写。
- 打开实时语音伙伴，以搜索、讨论工作，并在当前所选 harness 中启动任务。
- 选择会在 agent 工作时作出反应并承载实时语音控件的动画桌面宠物。GooeyPi 内置 Orb 和 GooeyPi 宠物，也能发现兼容的 Codex 宠物。

### 用得更舒适

- 选择浅色、深色或跟随系统主题，并调整界面文本大小。
- 使用英文、日文或简体中文界面，日期和时间跟随操作系统区域设置。
- 减少动效、调整工作区面板大小，或在窄窗口中让面板变为浮层。
- 使用键盘导航和命令面板完成常用操作。

## 开始使用

1. 安装 Pi、OMP、Prime Agent，或其中任意组合。
2. 通过各 harness 自己的 CLI 登录或配置模型服务商。
3. 从 [GitHub Releases](https://github.com/am-will/gooey-pi/releases) 下载 GooeyPi，或从源码运行。
4. 添加项目文件夹并启动会话。

GooeyPi 会自动检查常见安装位置。如果缺少某个 harness，请打开**设置 → 运行环境**刷新检测或选择其可执行文件。

GitHub Releases 提供 macOS 的 DMG 和 ZIP、常见 Linux 包格式及 AppImage，以及 Windows NSIS 安装包和 ZIP。

需要 macOS 14 Sonoma 或更高版本。发布验证会检查应用声明的最低版本及其原生模块的部署目标。

Harness 的服务商凭据仍由 harness 保存。可选的语音 key 使用操作系统安全存储加密，本地 `whisper.cpp` 听写不需要 API key。

## Star 历史

<a href="https://www.star-history.com/?repos=am-will%2Fgooey-pi&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=am-will/gooey-pi&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=am-will/gooey-pi&type=date&legend=top-left" />
    <img alt="Star 历史图表" src="https://api.star-history.com/chart?repos=am-will/gooey-pi&type=date&legend=top-left" />
  </picture>
</a>

## 从源码运行

你需要 Node.js 24.15.0 或更高版本，以及 npm 12.0.2 或更高版本。仓库在 `.nvmrc` 中固定了 Node.js 24.15.0；使用 [nvm](https://github.com/nvm-sh/nvm) 时，可以这样选择：

```bash
nvm install && nvm use
npm run toolchain:bootstrap
```

bootstrap 命令会从经过验证的本地归档中安装仓库固定的 npm 到当前 npm 配置的全局前缀，并禁用安装期生命周期脚本。随后它会检查所选工具链。详情请参阅[验证指南](docs/zh-CN/validation.md#可复现的环境搭建)。

```bash
npm ci
npm run dev
```

如果安装后缺少 `node_modules/electron/dist`，请在启动应用前获取 Electron 的平台二进制文件：

```bash
node node_modules/electron/install.js
npm run dev
```

`npm install --ignore-scripts` 会跳过 Electron 平台文件下载和原生依赖重建，因此单独使用它不足以从源码运行 GooeyPi。如果你使用了它，下面的恢复步骤会显式执行这两步。

`node-pty` 是原生依赖。如果 Electron 无法使用你默认的 Python 环境重建它，请将 npm 指向具备所需构建工具的 Python 安装：

```bash
export npm_config_python=/path/to/python3
npm ci --ignore-scripts
node node_modules/electron/install.js
npx electron-builder install-app-deps
```

## 键盘快捷键

macOS 使用 `⌘`，Linux 或 Windows 使用 `Ctrl`。

| 快捷键 | 操作 |
|---|---|
| `⌘/Ctrl+N` | 新建会话 |
| `⌘/Ctrl+K` | 命令面板 |
| `⌘/Ctrl+B` | 切换项目侧边栏 |
| `⌘/Ctrl+Shift+B` | 打开浏览器 |
| `⌘/Ctrl+J` | 切换终端 |
| `⌘/Ctrl+,` | 打开设置 |
| `Enter` | agent 工作时排队消息 |
| `⌘/Ctrl+Enter` | agent 工作时引导当前回合 |
| `Shift+Enter` | 插入换行 |
| `Esc` | 关闭当前菜单、对话框或浮层 |

Queue 和 Steer 快捷键可在**设置 → 运行环境 → 消息快捷键**中互换。

## 本地数据与安全

GooeyPi 围绕本地项目和本地 harness 会话构建。它会保留 harness 拥有的会话和凭据。离线状态下重命名 OMP 和 Pi 会话时，可能会更新其 JSONL 元数据；文件系统边界请参阅[安全模型](docs/security.md)（英文）。

远程页面在单独的浏览器配置中打开，并禁用 Node 访问。项目路径和桌面操作会在主进程中检查，第三方功能仍以你的操作系统权限运行。请先审查软件包、命令、MCP 服务器和项目，再允许它们执行操作。

如怀疑存在漏洞，请遵循[安全策略](.github/SECURITY.md)，不要在公开场合发布敏感细节。完整技术安全模型请参阅 [docs/security.md](docs/security.md)（英文）。

## 开发检查

自定义模型端点请参阅[连接兼容 OpenAI 的模型端点](docs/openai-compatible-providers.md)（英文）。[远程主机设计](docs/remote-hosts-design.md)（英文）描述了拟议的 SSH 架构及实现前需要做出的决策。

提交代码改动前请运行：

```bash
npm run typecheck
npm run check
npm run vendor:verify-patches
npm run test:coverage
npm run test:e2e
```

权威检查项和可复现命令请参阅[验证指南](docs/zh-CN/validation.md)，集成与安全参考请参阅[文档索引](docs/zh-CN/README.md)。

要生成可安装的本地 QA 构建，请运行对应操作系统的命令：

```bash
npm run package:mac:local-qa
npm run package:linux:local-qa
npm run package:win:local-qa
```

请在目标操作系统上构建软件包，以确保原生依赖与发布版本匹配。

## 贡献者

感谢我们的[贡献者、问题报告者和设计协作者](CONTRIBUTORS.md)。

## 许可证

GooeyPi 以宽松的 [MIT 许可证](LICENSE)发布。详情请参阅[许可证文本](LICENSE)。
