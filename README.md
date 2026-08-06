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
- 支持观察模式：只接收并分析状态，不发送游戏操作。

## 运行要求

- Windows 10 或 Windows 11
- [Node.js](https://nodejs.org/) 18 或更高版本
- Microsoft Edge、Google Chrome 或其他 Chromium 浏览器
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

### 第一步：启动 Node 桥接服务

双击项目根目录的：

```text
启动bot.bat
```

也可以在 PowerShell 中运行：

```powershell
npm run bridge
```

看到本地桥接服务启动后，不要关闭这个终端窗口。

### 第二步：打开并登录游戏

访问 [囤囤鼠历险记](https://grasp-rat-game.h-e.top/)，完成 LinuxDO 登录并进入游戏。

### 第三步：在浏览器中加载桥接脚本

1. 按 `F12` 打开开发者工具。
2. 切换到“控制台”面板。
3. 如果浏览器禁止粘贴，按照控制台提示手动输入 `allow pasting` 并回车。
4. 复制并执行下面这一行：

```javascript
fetch('http://127.0.0.1:8790/bridge.js').then(r => r.text()).then(t => { new Function(t)(); });
```

这行代码也保存在项目根目录的 [游戏控制台启动代码.txt](./游戏控制台启动代码.txt) 中。

如果控制台提示“还没抓到游戏连接”，回到游戏画面按一下 `W` 或 `D`，让脚本识别当前连接。

### 第四步：保持游戏标签页可见

浏览器可能限制后台标签页的计时器。运行期间请保持游戏标签页处于前台或至少保持可见，否则角色可能停止移动。

停止脚本时，在 Node 终端中按：

```text
Ctrl+C
```

## 观察模式

首次使用建议先运行观察模式。它只读取游戏状态，不发送移动、射击、传送或离开命令：

```powershell
npm run bridge:observe
```

然后按照上面的步骤登录游戏并加载浏览器桥接脚本。

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

确认已经在游戏页面的 F12 控制台执行桥接加载代码，并且控制台显示 Node 连接成功。若桥接脚本加载晚于游戏连接，可在游戏画面按一次 `W` 或 `D`。

### 运行 `npm start` 后持续出现 `Unexpected server response: 502`

浏览器的 WebSocket 可以返回 `101`，但 Node.js 直连可能被边缘网络拒绝。请停止直连模式，改用：

```powershell
npm run bridge
```

### 角色运行一段时间后停止移动

检查游戏标签页是否进入后台。Chromium 浏览器会限制后台标签页的脚本执行，请保持游戏标签页可见。

### 端口被占用

桥接模式默认使用：

- `ws://127.0.0.1:8787`：浏览器与 Node 的本地通信
- `http://127.0.0.1:8790/bridge.js`：浏览器桥接脚本

请先关闭重复启动的 Bot 窗口，再重新运行。

### 登录凭据是否会上传？

会话信息和运行状态保存在本机，并通过 `.gitignore` 排除。不要把授权回调 URL、token、Cookie、`.data` 文件或包含敏感参数的截图提交到 GitHub。

## 项目结构

```text
├─ src/                         Node.js 状态、策略与桥接服务
├─ userscript/                  浏览器桥接和探测脚本
├─ scripts/                     协议诊断脚本
├─ 启动bot.bat                  Windows 快速启动入口
├─ 游戏控制台启动代码.txt       浏览器控制台加载命令
├─ package.json                 npm 命令与依赖
└─ README.md                    GitHub 项目介绍与使用说明
```

## 使用提醒

- 本项目属于实验性工具，游戏更新后协议或页面结构可能发生变化。
- 使用前请自行确认游戏规则、服务条款及账号风险。
- 不要公开 token、Cookie 或带登录参数的完整 URL。
- 建议先使用观察模式确认状态读取正常，再启用自动操作。
