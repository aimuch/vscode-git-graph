# 上游 Issue 分诊记录（mhutchie/vscode-git-graph）

- 基线：上游 `develop@d7f43f4`（v1.30.0），作为本仓库首个提交 `Import upstream ...` 导入，上游历史未保留。
- 范围：2026-10-15 时上游仍为 open、标签为 `bug` / `vscode-bug` 的 74 个 issue（另有 136 个 feature request、61 个 improvement 未纳入本轮）。
- 验证：每个已修复项都有对应的端到端检查（`npm run compile && npm run test-e2e`），在本机真实的 VS Code 中运行（基线对比在 1.141.2 上完成，后续功能的完整回归在 1.142.0 上通过，报告见 [`docs/e2e/report-latest.json`](e2e/report-latest.json)），结果写入 `e2e/.artifacts/report.json`。同一套检查跑在未修改的上游代码上全部失败（见文末「基线对比」）。

## 1. 已修复（19 组共 24 个 issue，外加 VS Code 适配）

| Issue | 问题 | 修复 | E2E 检查 |
|---|---|---|---|
| #940 | **安全**：交互式 rebase 把分支名直接拼进终端命令，恶意分支名（如 `pwn$(calc)`）可执行任意命令 | 先用 `git rev-parse` 把目标解析为提交哈希，终端里只出现十六进制哈希（`src/dataSource.ts`） | `#940` |
| #935 #880 #641 #930 | 提交标题里有裸 CR（`\r`）时，之后的所有历史都加载不出来。#930 很可能是同一问题：PowerShell 里 `` `r `` 会被转义成 CR（根据截图推断，未用 PowerShell 复现） | `git log` / stash 记录只按 LF 切分；格式异常的记录跳过而不是中断 | `#935` |
| #903 #871 | VS Code 1.106+ 的 Source Control「Repositories」视图里，每个仓库上的 Git Graph 按钮消失 | 新增 `scm/repository` 菜单贡献（VS Code 新增的贡献点，见 microsoft/vscode#278608），保留 `scm/title` | `#903` |
| #794 | 点击 View Git Graph 报 `Cannot read properties of null (reading 'rootUri')` | 命令参数为 `null` 时不再访问 `rootUri` | `#794` |
| #932 | 环境里已有 `GIT_ASKPASS`（如 Coder、远程开发环境）时被 Git Graph 覆盖，导致认证失败 | 已存在且不是 VS Code / Git Graph 自身的 askpass 时保留它（目前没有提供关闭此行为的设置） | `#932` |
| #708 | 同名的 tag 和分支无法推送 / 在远端删除（refspec 有歧义） | push / delete 统一使用完整引用 `refs/tags/…`、`refs/heads/…` | `#708` |
| #789 | 子模块在 VS Code 外（终端）提交后，图不会自动刷新 | 额外监听仓库外部的 Git 目录（`.git` 文件指向的 gitdir 与 commondir） | `#789` |
| #668 | worktree 的识别与刷新 | 作为工作区子目录的 worktree 能被识别（E2E 验证；直接把 worktree 作为工作区打开的场景未单独测试）；同上修复了 worktree 在 VS Code 外变更后不刷新的问题 | `#668`、`#668-watch` |
| #892 #834 | Git Graph 获得焦点时，VS Code 的组合快捷键（如 Ctrl+K Ctrl+S）的第二个按键被 Git Graph 吞掉 | 未被 Git Graph 处理的 Ctrl/Cmd+字母视为可能的组合键起始，1.5 秒内的下一次按键交给 VS Code（代价：例如按 Ctrl+B 后 1.5 秒内按 Ctrl+F，会打开 VS Code 的查找而不是 Git Graph 的） | `#892` |
| #928 | 对话框中 (i) 图标等的提示不显示（VS Code 维护者确认 Webview 内原生 `title` 提示不可靠） | Webview 内自绘 tooltip，接管所有带 `title` 的元素 | `#928` |
| #856 | 用鼠标右键粘贴分支名后「Create Branch」按钮仍是禁用状态 | 校验从 `keyup` 改为 `input` 事件 | `#856` |
| #652 | 对话框按钮无法用 Tab 聚焦 | 按钮加入 Tab 顺序（排在输入框之后），支持 Enter / Space 触发 | `#652` |
| #792 | 自定义协议的 issue 链接（如 `linear://`）点击无反应 | 非标准协议的链接由扩展通过 `vscode.env.openExternal` 打开（`file:`、`javascript:` 等仍被拒绝） | `#792` |
| #707 | issue 链接指向 `github.com/mhutchie/repo/...` | 示例文案不再使用 `mhutchie/repo`；根据远端（GitHub / GitLab / Bitbucket）自动预填 Issue URL | `#707` |
| #723 | 重命名的文件在提交详情里只显示新名字 | 文件树中显示「← 原文件名」 | `#723` |
| #857 | 大仓库里 HEAD 不在已加载的提交中时「Scroll to HEAD」无效 | 显示全部分支或包含当前分支时，自动继续加载更多提交直到 HEAD 出现（只显示其他分支时不加载，避免遍历整个历史） | `#857` |
| #852 | 鼠标侧键（后退 / 前进）在 Git Graph 上无效 | 转发为 `workbench.action.navigateBack/Forward`（遵循 `workbench.editor.mouseBackForwardToNavigate`） | `#852` |
| #864 | 键盘 Menu 键 / Shift+F10 只弹出 Cut/Copy/Paste | 打开当前键盘选中提交的上下文菜单 | `#864` |
| #719 | 代码库无法构建 | 工具链升级（TypeScript 5.9、ESLint 10 flat config、Jest 30、`@vscode/vsce`）；上游代码在当前 Node 下编译会因依赖的类型声明报错 | `npm run compile` |
| — | 适配最新 VS Code | `activationEvents` 由 `*` 改为 `onStartupFinished`；`engines.vscode` 提升到 `^1.85.0`；替换已废弃的 `url.parse()`；Webview 资源 / CSP 在 1.141 下验证可用 | `activation`、`webview-csp` |

## 2. 属于 VS Code / Electron / 其他软件的问题（扩展侧无需或无法修复）

| Issue | 结论 |
|---|---|
| #863 | VSCodium 右键菜单只有 Cut/Copy/Paste：Electron 的 bug（electron/electron#44976），VS Code 1.97.2 已修复，需等待 VSCodium 跟进 |
| #524 #646 #770 #732 #725 #685 | `Could not register service worker` / 页面空白：VS Code 的 Webview service worker 问题（microsoft/vscode#125993），完全退出 VS Code 或清理 `CachedData` 可恢复 |
| #818 | 同上（评论中通过清理 `CachedData` 解决） |
| #712 | 内存暴涨：评论确认是 VS Code / Electron 问题，VS Code 1.78 已修复 |
| #686 | 与新三方合并编辑器冲突：VS Code 侧问题（microsoft/vscode#156361） |
| #609 #529 | 上游已标记为 `vscode-bug`（编辑器组 Beside 的语义、快捷键作用域由 VS Code 决定） |
| #823 | `scm.workingSets` 切分支时关闭所有编辑器（包括 Webview）：VS Code 功能本身的行为 |
| #854 | `.rst` 的 diff 高亮：VS Code diff 编辑器的行为 |
| #846 | 报错来自 PowerShell 的 PSReadLine，不是 Git Graph |
| #882 | 评论已确认是 VS Code 内置 Git 扩展的问题 |
| #879 #733 #889 #819 | 非 bug（提问 / 无有效内容） |

## 3. 无法在本机复现 / 需要特定环境（未改动）

| Issue | 说明 |
|---|---|
| #942 | 仅 WSL 远程 + VS Code 1.141.1。截图显示 Webview 的 CSS 和 JS 都没有加载（只剩原始 HTML），属于远程 Webview 资源加载失败。本机 1.141.2 下 `webview-csp` / `#794` 检查确认资源正常加载；需要在 WSL 环境复测 |
| #872 #803 #827 #654 #774 #726 #704 | Remote-SSH、WSL2、Dev Container、Cygwin 等环境下找不到 git / 无法加载 / 交互式 rebase 不工作，缺少可复现信息 |
| #734 | Git 版本识别：与 PATH / `git.path` 环境有关，需要具体环境 |
| #778 | 子模块输出超过 512MB 字符串上限，需复现仓库 |
| #720 #648 #671 | Windows 上 File View 为空、卡死、无法加载，信息不足 |
| #730 #755 #672 | 推送 / SSH passphrase / 仅 HTTPS 的 GitLab 认证流程，需对应账户环境；#932 的修复可能改善部分场景 |
| #814 | 比较提交时使用了错误的源提交，提供了复现仓库，留待后续排查 |
| #875 | 一个文件夹里有多个仓库时无法切换：很可能与搭建 E2E 时观察到的现象相同——工作区文件夹本身位于某个 Git 仓库内时，Git Graph 只识别外层仓库，不再搜索其中嵌套的仓库（上游的设计）。留待后续处理 |
| #858 #820 #817 #845 #847 #868 | 信息不足或需要进一步排查 |

## 4. 设计如此 / 改动较大，延后处理

| Issue | 说明 |
|---|---|
| #693 | 只有大小写不同的分支名：大小写不敏感文件系统上 Git 自身就无法同时存在两个松散引用 |
| #741 | 隐藏远端后其 tag 仍可见：Git 的 tag 不属于某个远端，需要新的过滤设计 |
| #743 | rebase 后只看当前分支时 stash 不显示：stash 的基提交已不在所选分支上，属于当前设计 |
| #790 | 嵌套 worktree 显示为未提交更改：`git status` 本身把它报告为未跟踪目录，可通过 `.gitignore` 处理 |
| #745 | 通过 VS Code 原生右键菜单复制提交信息失败（Ctrl+C 可用） |
| #899 #634 #937 | 功能需求性质：Markdown 链接、reflog 视图、关闭切换标签页时的自动刷新 |

## 基线对比

`E2E_EXTENSION_PATH=<已编译的扩展目录> npm run test-e2e` 可让同一套检查跑在任意一个已编译的扩展上。下表是同一台机器上，对未修改的上游 v1.30.0（从源码构建）和本版本分别运行的结果。所有针对 bug 的检查在上游都失败、且失败原因就是对应的 bug（例如 `#940` 在上游确实执行了分支名里的命令替换），说明这些检查能识别出对应问题。

`webview-csp` 和 `#668`（仓库发现）在上游也通过：它们是守护性检查，用来确认 Webview 资源在 VS Code 1.141 下能加载、以及 worktree / 子模块能被发现，上游在 macOS 上本来就没问题。

原始报告（路径已脱敏）：[`docs/e2e/report-upstream-1.30.0.json`](e2e/report-upstream-1.30.0.json)、[`docs/e2e/report-2.0.0.json`](e2e/report-2.0.0.json)。

Visual Studio Code 1.141.2（扩展宿主 Node v24.21.0），git version 2.56.0，darwin arm64。

| 检查 | 内容 | 上游 v1.30.0 | 本版本 2.0.0 | 上游失败原因 |
|---|---|---|---|---|
| `activation` | Git Graph activates in this version of Visual Studio Code (onStartupFinished) | FAIL | PASS | Unexpected activation events: ["*"] |
| `#903` | "View Git Graph" is contributed to the scm/repository menu (Source Control Repositories view) | FAIL | PASS | No inline scm/repository menu item |
| `#794` | The "View Git Graph" command opens the view when invoked with a null argument | FAIL | PASS | Timed out waiting for the Git Graph View to open |
| `webview-csp` | The Webview HTML loads its script & stylesheet through the Webview resource URIs and CSP of this version | PASS | PASS |  |
| `#668` | Repositories, submodules and worktrees in the workspace are all discovered | PASS | PASS |  |
| `#935` | Commits after a commit whose subject contains a raw CR character are loaded (from the Webview) | FAIL | PASS | The raw CR character was not preserved in the subject |
| `#940` | Interactive rebase on a branch whose name contains shell syntax does not execute it | FAIL | PASS | The command substitution in the branch name was executed by the shell |
| `#708` | Tags & branches that share a name can be deleted from and pushed to a remote | FAIL | PASS | Deleting the tag failed: error: dst refspec asd matches more than one |
| `#932` | An externally configured GIT_ASKPASS is used for authentication instead of Git Graph's | FAIL | PASS | Timed out after 30000ms: fetching from the remote requiring authentication (Git Graph's own Askpass prompt would wait for input) |
| `#789` | The view refreshes when a commit is made in a submodule from outside of Visual Studio Code | FAIL | PASS | Timed out waiting for the extension to tell the Webview to refresh |
| `#668-watch` | The view refreshes when a commit is made in a worktree from outside of Visual Studio Code | FAIL | PASS | Timed out waiting for the extension to tell the Webview to refresh |
| `#857` | [Webview UI] "Scroll to HEAD" loads more commits until HEAD is loaded | FAIL | PASS | Timed out waiting for more commits to be requested |
| `#892` | [Webview UI] The second keypress of a keybinding chord (e.g. Ctrl+K Ctrl+H) is left to Visual Studio Code | FAIL | PASS | Git Graph handled the second keypress of the chord |
| `#928` | [Webview UI] Tooltips are shown for elements with a title (e.g. the (i) icons) | FAIL | PASS | The title attribute should be removed while hovering, so the native tooltip isn't also shown |
| `#852` | [Webview UI] The mouse back / forward buttons navigate the editor history | FAIL | PASS | Unexpected navigation requests: [] |
| `#723` | [Webview UI] Renamed files show their original name in the Commit Details View | FAIL | PASS | Unexpected labels: [] |
| `#792` | [Webview UI] Issue links using a custom URL scheme are opened (via the extension) | FAIL | PASS | The click wasn't handled |
| `#864` | [Webview UI] The Menu key / Shift+F10 opens the context menu of the commit selected with the keyboard | FAIL | PASS | Timed out waiting for the context menu to open |
| `#856` | [Webview UI] Pasting a branch name with the mouse enables the "Create Branch" button | FAIL | PASS | The "Create Branch" button is still disabled |
| `#652` | [Webview UI] The dialog buttons can be focused with Tab (after the inputs), and activated with Enter | FAIL | PASS | Unexpected tab order: inputs [1,2], buttons -1, -1 |
| `#707` | [Webview UI] Adding Issue Linking prefills the Issue URL of the repository's GitHub remote (not an example URL) | FAIL | PASS | Unexpected Issue URL:  |

上游 v1.30.0 通过 2/21，本版本通过 21/21。
