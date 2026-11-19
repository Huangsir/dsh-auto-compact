# dsh-auto-compact

**中文** · [English](./README.en.md)

**会话级自动上下文压缩插件**（DeepSeek Harness / DSH）

![自动压缩阈值面板](docs/screenshots/panel.png)

在输入区右侧显示阈值圆环与实时上下文用量。未手动设置的会话按当前模型在 profile 中显式配置的最大 Context 选择默认阈值：小于 300K 为 80%，大于 800K 为 30%，其余或未知为 50%。三个默认值可在插件配置页保存为 1–99 的整数百分比。拖动滑杆可设置当前会话的手动阈值（10%–90%，步进 5%），并优先于模型默认；「恢复默认」清除该 override。每当用量超过阈值，插件在回合中每步前及回合结束时自动执行 compact，摘要注入后会话自然继续，不发送额外「继续」消息。

## 特性

- 🔴 **会话级手动阈值**：独立持久化，切模型保留；恢复默认后重新跟随模型和插件配置
- 📊 **实时用量**：与自带 ContextMeter 同源（`useProjection("contextPressure")`），响应投影更新
- 🎚️ **10%–90% 滑杆**：步进 5%；配置 23% 或历史手动 37% 会原值显示，仅用户拖动后进入刻度
- ⚙️ **模型分档默认**：三个 live 配置字段，支持 Save、Discard 和各字段 Reset
- 🎨 **主题面板**：背景完全不透明，随深浅主题配色；外部点击关闭且底层控件继续响应，内部空白点击保持打开
- 🤖 **全自动**：回合中每步前 + 回合结束自动检测 → 超阈值自动 compact → 摘要注入后自然继续
- 🛡️ **零崩溃风险**：所有检查都在 `agent/pre-step`（waterfall 中间件）与 `agent/turn-stopping`（串行事件）里做，全程 try/catch，绝不抛出
- 💾 **持久化**：阈值存于插件自己的 JSON 文件（`$DSH_HOME/dsh-auto-compact.json`，默认 `~/.dsh/dsh-auto-compact.json`），重启不丢
- 🧊 **与内置安全网并存**：DSH 自带的 `compaction-basic`（默认 80% 压力阈值）保留为兜底，互不干扰

## 安装

**前置**：DSH ≥ 0.2.0-rc.2 且 < 0.3（live 配置表单与会话选择接口在 0.2.0-rc.2 与 0.2.1-alpha.2 两条线上均通过真实组件验证），Node.js ≥ 20。开发测试依赖 jsdom 30，使用 Node.js ≥ 24；本次验证为 Node 24.21。

> **从旧版 auto-compact 升级**：旧包名是 `auto-compact`，新包名是 `dsh-auto-compact`。请先卸载旧包再装新版，避免双挂载（两个 Host 半、两个圆环）：
> ```bash
> npx -y --package @deepseek-ai/dsh dsh plugin --profile web remove auto-compact
> ```

### 一键安装（推荐，复制粘贴即可）

**macOS / Linux**（Windows 装 Git Bash 或 WSL 也可）：

```bash
curl -fsSL https://raw.githubusercontent.com/Huangsir/dsh-auto-compact/master/scripts/install.sh | bash
```

脚本自动完成全部步骤：安装 npm 依赖 → 注册官方挂载（`dsh.profile.bundles`）→ 清理旧版残留的挂载行。你只需要：

1. 跑上面这一条命令
2. **重启 DSH**（装完后脚本会提示命令；也可以加上 `--restart` 让它自动重启：`curl ... | bash -s --restart`）
3. 强刷浏览器（macOS `Cmd+Shift+R` / Windows·Linux `Ctrl+Shift+R`），输入区右侧出现阈值圆环 ✅

> 脚本内部已自动处理：`dsh` 命令通常不在全局 PATH（DSH 一般经 npx 安装，直接敲 `dsh` 会报 command not found），脚本会自动改用 npx 调用，无需用户手动处理。

### 或者用

```bash
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-auto-compact
```

装完同样需要重启 DSH + 强刷浏览器。

### 从本地 checkout 安装（npm 未发布时）

`dsh-auto-compact` 目前尚未发布到 npm，上面的 `dsh plugin --profile web add dsh-auto-compact` 需要可用的 npm 源。若你只想跑本地代码，直接把 checkout 链接进 profile：

```bash
git clone https://github.com/Huangsir/dsh-auto-compact.git
cd dsh-auto-compact
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add "$PWD"
```

pnpm 会以 `link:` 方式把 profile 指向这份 checkout（改完代码重启 DSH 即生效，无需重装）；包内声明的 `dsh.bundle.patch` 仍会被 CLI 协调进 `dsh.profile.bundles`。

### 更新 / 卸载

- **更新**：重跑一键安装命令（或手动命令），装完重启 DSH + 强刷浏览器
- **卸载**：`npx -y --package @deepseek-ai/dsh dsh plugin --profile web remove dsh-auto-compact`，卸载后重启生效；若曾手动在 `cordis.patch.yml` 写过挂载行，一并删除，避免双挂载（两个 Host 半、两个圆环）

## 使用

1. 在宿主插件配置页设置「模型最大 Context 小于 300K」「模型最大 Context 大于 800K」「其余情况」，输入 1–99 的整数百分比；Save 保存，Discard 放弃草稿，Reset 清除字段 override 后仍需 Save。
2. 点击输入区右侧的圆环。面板显示有效阈值和实时上下文用量。恰好 300K、800K 归「其余情况」。
3. 拖动 10%–90%、步进 5% 的滑杆保存当前会话手动阈值。已有非刻度值保持原值，游标显示附近刻度，不会在打开面板时重写。
4. 点击「恢复默认」删除本会话手动 override，立即显示当前模型默认值；此后切模型或保存插件配置会继续更新默认。
5. 面板外点击会关闭并继续触发底层控件，内部空白点击不会关闭。保存失败显示错误并保留已接受的阈值。
6. 切模型、保存配置和恢复默认只更新阈值；仍等下一次每步前或回合结束检查才决定是否 compact。

## 工作原理

- **Host 半**（`lib/index.js`）：监听 `agent/pre-step`（回合中每步之前，waterfall 中间件）与 `agent/turn-stopping`（回合结束，串行事件）两个事件，读取当前会话阈值与用量（`tokenMeter.measure()` / `contextPressure` 投影），超阈值时调用 `agentPresets.serviceFor(agent, 'compaction').compactIfNeeded(agent, 'context-overflow', signal)` 执行压缩 —— 走 context-overflow 分支，绕过引擎自身的 0.8 阈值检查，完全由滑杆决定。
- **Client 半**（`lib/client.js`）：在 `conversation.input.right` 注册圆环，在 `plugins.bundle.config` 注册宿主配置表单。通过 `/dsh-auto-compact/api/thresholds.resolve` 获取后端权威有效阈值，`thresholds.set` 保存手动值，`thresholds.reset` 删除 override。旧 `thresholds.get/set` 仍提供手动表读写。
- **冷会话解析**：重启后尚未激活的持久化会话（会话被激活前圆环就要显示）由宿主经只读会话查询 `sessionQuery.observeSession` 解析，不把会话拉进内存；查询不可用或会话不存在仍拒绝，client 不传模型容量。cordis 只把 `inject` 声明的服务暴露成 ctx 属性——未声明的名字做 `ctx.sessionQuery` 会直接抛 `cannot get property ... without inject`，`ctx.sessionQuery ?? ctx.get(...)` 的兜底因此永远走不到，冷路径只剩 400（表现就是重启后圆环停在零弧「加载中」，切会话或切模型才恢复）。宿主改为按 DSH 官方对可选服务的写法用子 fiber 绑定：`ctx.inject(['sessionQuery'], child => …)`，服务缺席时子 fiber 保持 pending、插件照常加载，服务就绪后回调挂上实现；另以 `ctx.get('sessionQuery', false)` 兜底，没有 `ctx.inject` 的旧宿主走 `ctx.get`。
- **客户端重试**：首次读取失败按 400ms → 1s → 2.5s → 5s → 10s 有界退避重试（切会话或切模型会取消失效重试），宿主把会话转成 live 或刚就绪后自行恢复，不必再靠手动切换把圆环救回来。
- **模型容量**：以当前会话 `modelSelection.next` 为先，再用最新 request header；全新会话用宿主当前默认选择。读取 `$DSH_PROFILE_DIR/cordis.patch.yml`，或无该变量时 `$DSH_HOME/profiles/$DSH_PROFILE/cordis.patch.yml`（home 默认 `~/.dsh`）；GUI 宿主进程不导出这两个变量，此时用**唯一**在自身 `package.json` 中声明本插件依赖的 profile 目录定位，多个或没有则回落其余档。provider 和完整 model id 精确匹配，model 内斜杠不拆。仅显式正安全整数 `contextWindow` 参与分档；读取失败、未匹配、无法可靠解释的 patch 或容量无效归其余。`!!js` 不求值，不从内置模型目录或最近请求压力容量推断默认。
- **持久化**：JSON 的 `thresholds` 只存显式会话 override，自动默认不写入。写入成功才发布新值；配置保存由宿主 revision 表单处理。用量与其分母仍使用 `tokenMeter` / `contextPressure`，分档容量来源独立。

## 依赖

- 需要 DSH 的 `compaction-basic`（`@deepseek-ai/dsh-compaction-basic`）处于启用状态 —— 默认预设（standard / code / cordis）均已内置，`minimal` 预设除外
- 所有 peer 依赖随 DSH 自带，无需额外安装

### 兼容性闸门（发版前必跑）

    npm test
    npm run check:compat -- --dsh /path/to/dsh --runtime 0.2.0-rc.2 --runtime 0.2.1-alpha.2
    node --check lib/index.js
    node --check lib/client.js
    npm pack --dry-run

脚本调用的是 DSH 自带的那个评估器（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`），
所以这里的判定与 DSH 加载插件时的判定完全一致——不是另写一套 semver 规则。

peer 上界刻意写成"下一个 minor 的预发布地板"：

    >=0.2.0-rc.2 <0.3.0-0 # 新增配置/选择接口的已验证地板（0.2.0-rc.2 与 0.2.1-alpha.2 均实测）；挡掉 0.3.0-rc.1

DSH 升到新 minor（例如 0.3）时：把上界改成 `<0.4.0-0`，用新运行时跑一遍上面的检查，再发版。
上界的 `-0` 不能省——写成 `<0.4.0` 反而会把最危险的 `0.4.0-rc.1` 放进来。
不想改包时应急：`dsh plugin allow-version` 给"插件@精确版本"开豁免。

## 许可证

MIT
