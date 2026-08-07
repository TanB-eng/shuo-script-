# 囤囤鼠拾金生存 Bot

一个面向《囤囤鼠历险记》的 Node.js 自动化脚本。脚本以拾取金币为主要目标，以保命为最高优先级：满血后寻找金币、受击后才反击、危险时自动传送或暂时离开游戏。

> [!IMPORTANT]
> 当前推荐使用“浏览器桥接模式”。直接运行 `npm start` 连接游戏 WebSocket，可能被边缘网络返回 `502`，不适合作为普通用户的启动方式。

## 当前功能

- 满血后才开始寻找金币，未满血时原地等待恢复。
- 自动选择距离较近、周围玩家风险较低的金币。
- 保留部分 1 小时体力，避免拾金耗尽逃生能力。
- 默认不主动攻击其他玩家。
- 检测到掉血并识别出攻击者后，才会主动反击。
- 当前默认在 `HP < 90` 且正在受攻击时触发逃生。
- 配置了安全坐标且体力足够时优先传送，否则离开可见实体层。
- 当前默认离线等待 `90` 秒，然后重新加入游戏。
- 重新加入后必须恢复满血，才会继续拾取金币。
- Node 桥接连接运行在 Web Worker 中，切换到后台标签页时仍可维持连接和心跳。
- 支持观察模式：只接收并分析状态，不发送游戏操作。

## 运行要求

- Windows 10 或 Windows 11
- [Node.js](https://nodejs.org/) 18 或更高版本
- Microsoft Edge、Google Chrome 或其他 Chromium 浏览器
- [篡改猴（Tampermonkey）](https://www.tampermonkey.net/) 浏览器扩展
- 能够正常登录游戏的 LinuxDO 账号

## 下载项目

### 方法一：下载 ZIP

1. 打开本仓库首页。
2. 点击绿色的 **Code** 按钮。
3. 点击 **Download ZIP**。
4. 下载完成后解压到一个固定目录。

也可以直接下载：[master 分支 ZIP](https://github.com/TanB-eng/shuo-script-/archive/refs/heads/master.zip)。

### 方法二：使用 Git

```powershell
git clone https://github.com/TanB-eng/shuo-script-.git
cd shuo-script-
```

## 安装依赖

在项目目录打开 PowerShell，然后运行：

```powershell
npm install
```

安装成功后即可启动。项目目前只依赖 `ws`。

## 推荐启动方式

浏览器桥接模式由浏览器保持真实的游戏连接，Node.js 负责分析状态并作出决策。这可以避开 Node.js 直接连接游戏 WebSocket 时可能遇到的 `502`。

### 第一步：在篡改猴中导入桥接脚本

1. 安装并启用篡改猴（Tampermonkey）浏览器扩展。
2. 打开篡改猴的“管理面板”。
3. 进入“实用工具”，选择“从文件导入”。
4. 选择项目中的 [userscript/grasp-rat-bridge.user.js](./userscript/grasp-rat-bridge.user.js)。
5. 确认安装，并确保该脚本处于启用状态。

脚本只匹配 `https://grasp-rat-game.h-e.top/*`，并会在游戏页面加载时自动运行，不需要再打开 F12 控制台粘贴代码。

### 第二步：启动 Node 桥接服务

双击项目根目录的：

```text
启动bot.bat
```

也可以在 PowerShell 中运行：

```powershell
npm run bridge
```

看到本地桥接服务启动后，不要关闭这个终端窗口。

### 第三步：打开并登录游戏

访问 [囤囤鼠历险记](https://grasp-rat-game.h-e.top/)，完成 LinuxDO 登录并进入游戏。如果游戏页面在导入脚本前已经打开，请刷新页面，让篡改猴从页面加载阶段注入桥接脚本。

### 第四步：长期后台挂机（推荐）

普通把游戏标签丢到后台，Chromium 仍可能在几分钟后冻结**主线程**（游戏 WebSocket 在主线程），于是快照停更、角色不动。

若要**尽量不手动切回标签页**，请用项目自带的无节流浏览器：

1. 先运行 `启动bot.bat`（或 `npm run bridge`）
2. 再双击 `启动无节流浏览器.bat`
3. 在这个独立浏览器里安装篡改猴，并导入 `userscript/grasp-rat-bridge.user.js`
4. 登录游戏后即可最小化窗口挂机

该启动器使用独立用户目录，并关闭后台定时器节流 / 遮挡降速 / 渲染后台限制。这是目前最稳的“一直后台运行”方案。

### 第五步：后台挂机说明（普通浏览器）

当前篡改猴脚本已把 Node 桥接连接移入 Web Worker。游戏标签页进入后台后，Node 桥接通常仍会保持实时连接，`vel` 心跳不会因普通的后台计时器节流而中断，角色可以继续移动。

游戏 WebSocket、页面 DOM 和最终命令转发仍有一部分运行在浏览器主线程，因此后台运行时可能出现消息或画面延迟。请避免让浏览器休眠、冻结或丢弃游戏标签页；需要最低延迟时，仍建议保持游戏页面在前台。

停止脚本时，在 Node 终端中按：

```text
Ctrl+C
```

## 观察模式

首次使用建议先运行观察模式。它只读取游戏状态，不发送移动、射击、传送或离开命令：

```powershell
npm run bridge:observe
```

然后确认篡改猴脚本已启用，再刷新或打开游戏页面。

## 本地配置

如需调整默认参数，在项目根目录新建 `config.json`：

```json
{
  "escapeHp": 90,
  "offlineCooldownSec": 90,
  "safeTeleport": null,
  "logLevel": "info"
}
```

常用配置：

| 配置项 | 默认值 | 作用 |
| --- | ---: | --- |
| `escapeHp` | `90` | 正在受攻击且 HP 低于该值时逃生 |
| `offlineCooldownSec` | `90` | 离开游戏后等待多少秒再重新加入 |
| `safeTeleport` | `null` | 安全传送坐标，例如 `[1000, 2000]`；未配置时直接离开 |
| `logLevel` | `info` | 日志等级 |

`config.json` 已被 Git 忽略，只用于本机。请先确认坐标有效，再配置 `safeTeleport`。

## 其他启动命令

| 命令 | 说明 |
| --- | --- |
| `npm run bridge` | 推荐：启动浏览器桥接 Bot |
| `npm run bridge:observe` | 推荐：启动只读观察模式 |
| `npm start` | 开发用途：Node.js 直接连接游戏 WebSocket，可能返回 `502` |
| `npm run auth` | 直连模式的授权入口，不是桥接模式必需步骤 |

## 常见问题

### Node 终端一直显示“等待浏览器桥接接入”

确认篡改猴中的 `grasp-rat-bridge.user.js` 已启用，并确认当前页面地址是 `https://grasp-rat-game.h-e.top/`。启动 Node 桥接后刷新游戏页面；如果仍未接入，请检查篡改猴是否显示该脚本正在当前页面运行。

### 运行 `npm start` 后持续出现 `Unexpected server response: 502`

浏览器的 WebSocket 可以返回 `101`，但 Node.js 直连可能被边缘网络拒绝。请停止直连模式，改用：

```powershell
npm run bridge
```

### 后台挂机时是否会停止移动？

当前 `grasp-rat-bridge.user.js` 使用 Web Worker 保持 Node 桥接连接和心跳，普通的标签页后台节流通常不会再直接导致角色停止移动。

如果仍然停止，请检查浏览器是否启用了休眠标签页、内存节省或节能功能，并确认游戏页面没有被浏览器冻结或丢弃。游戏 WebSocket 仍在主线程中，后台状态下可能出现一定延迟。

### 端口被占用

桥接模式默认使用：

- `ws://127.0.0.1:8787`：浏览器与 Node 的本地通信
- `http://127.0.0.1:8790/bridge.js`：旧版控制台加载方式使用的备用脚本地址

请先关闭重复启动的 Bot 窗口，再重新运行。

### 登录凭据是否会上传？

会话信息和运行状态保存在本机，并通过 `.gitignore` 排除。不要把授权回调 URL、token、Cookie、`.data` 文件或包含敏感参数的截图提交到 GitHub。

## 项目结构

```text
├─ src/                         Node.js 状态、策略与桥接服务
├─ userscript/                  篡改猴桥接脚本和协议探测脚本
├─ scripts/                     协议诊断脚本
├─ 启动bot.bat                  Windows 快速启动入口
├─ 游戏控制台启动代码.txt       旧版控制台加载方式的备用命令
├─ package.json                 npm 命令与依赖
└─ README.md                    GitHub 项目介绍与使用说明
```

## 使用提醒

- 本项目属于实验性工具，游戏更新后协议或页面结构可能发生变化。
- 使用前请自行确认游戏规则、服务条款及账号风险。
- 不要公开 token、Cookie 或带登录参数的完整 URL。
- 建议先使用观察模式确认状态读取正常，再启用自动操作。
