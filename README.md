# x-console 0.1.1

x-console 是 Xmake Addon，为工程提供 Linux 和 Windows 串口终端。执行系统、运行命令、串口、速率、交互模式和控制线由 `config` 显式传入；插件不解析 `board.lua`，也不安装运行依赖。

Linux 后端使用 Python 和系统串口接口，逐字符转发；Windows 后端由 Node.js 处理终端输入，PowerShell 的 `.NET SerialPort` 持有串口，可选择按行提交或按字节转发。从 WSL 调用 Windows 时，串口仍由 Windows 访问。下载和调试由独立的 [x-pyocd](https://github.com/wmem/x-pyocd) 提供，两者互不依赖。

## 安装与命令

需要支持 Addon 的 Xmake。Linux 后端需要已有 Python；Windows 后端需要已有 Node.js 和 PowerShell，从 WSL 执行时还需要 `wslpath`。

本地开发时，在本仓库根目录准备并安装；输出目录须尚不存在：

```sh
xmake lua scripts/prepare-addon.lua /tmp/x-console-addon-stage
xmake addon --install /tmp/x-console-addon-stage
```

这里安装的是 Xmake 插件，不会安装 Python、Node.js 等运行依赖。消费工程可声明版本化依赖：

```lua
add_repositories("kunyi git@github.com:wmem/xmake-addons.git")
add_addons("x-console 0.1.1")
```

版本化安装需要索引仓库中的对应配方及其固定的源码提交。

安装后，在消费工程的交互终端执行：

```sh
xmake x-console --config=serial.json --dry-run
xmake x-console --config=serial.json
```

`--dry-run` 仅校验并输出配置，不打开串口；它不能证明串口或执行命令可用。正常会话使用 Ctrl+C 退出，实际执行失败时以非零状态退出。

## Linux 与 Windows 配置

以下为 Linux Lua API 配置示例，串口和解释器路径须替换为真实值：

```lua
local config = {
    host = "linux",
    mode = "raw",
    runtime = {python = "/path/to/prepared/python"},
    serial = {
        port = "/dev/ttyUSB0",
        baud_rate = 115200,
        data_bits = 8,
        parity = "none",
        stop_bits = 1,
        flow_control = "none",
        board_control = {dtr = false, rts = false},
    },
}
```

Linux 后端要求 Xmake 运行在 Linux，串口可见且当前用户有访问权限。Python 也可写成 `{program = "<命令>", args = {...}}`。当前 stdin 必须是交互终端；Ctrl+C 由本机消费，退出时恢复终端状态并关闭串口。

Windows 使用相同串口参数结构，替换以下字段：

```lua
config.host = "windows"
config.mode = "raw" -- 交互终端逐字节转发；需要按行提交或管道输入时选择 line。
config.serial.port = "COM23"
config.runtime = {
    node = "node",
    powershell = "powershell.exe",
    wslpath = "wslpath", -- 从 WSL 执行时必填；Windows 原生不需要。
}
```

COM23 和 115200 都是示例值，插件不会探测或猜测板卡串口。`runtime.node` 是运行当前终端进程的命令，`runtime.powershell` 是持有 Windows 串口的命令；从 WSL 运行时，Node.js 与 PowerShell 通过进程 stdin/stdout 交换 JSON 请求及响应。

CLI 的 `serial.json` 与上述 table 字段相同，使用 JSON 语法。所有硬件参数都必填；`board_control` 可为空对象，表示不主动设置 DTR/RTS，或显式配置布尔值。当前支持的串口合同为 8N1、无流控；其他数据位、校验位、停止位或流控配置会明确失败。

## 交互及退出行为

| 后端 | 当前支持的 mode | 输入和输出 |
| --- | --- | --- |
| Linux | `raw` | 按字符发送输入，并转发串口收到的字节；Ctrl+C 结束本机会话 |
| Windows | `raw` | 按字节发送键盘输入，Tab、方向键及退格交由设备处理；接收字节原样输出；Ctrl+C 本地退出 |
| Windows | `line` | 回车后提交一行命令，空闲时轮询串口输出；支持管道输入和 EOF 退出 |

平台与模式须同时显式配置，更换 `host` 不会自动改写 `mode`。Windows `raw` 要求交互终端，关闭本地回显和行编辑；Ctrl+C 本身及同一批中其后的字节不会发往设备，退出后恢复原终端模式。Windows `line` 保持原有行为。

Windows 字节通道使用 Base64 JSON RPC，不经过 UTF-8 解码；任意串口字节及跨响应拆分的多字节字符均原样转发。该模式适用于设备端 Shell，Ctrl+C 被终端保留为退出键，因此并非完全透明的二进制协议终端。公开运行时 `Serial.exchange(text, waitMs)` 保留文本合同，`Serial.exchangeBytes(bytes, waitMs)` 返回 `Buffer`；二者共用同一笔在途事务限制。

Windows 的轮询间隔、写入超时、进程请求超时、关闭超时及单次最大接收字节数可通过 `poll_ms/write_timeout_ms/rpc_timeout_ms/close_timeout_ms/max_receive_bytes` 配置。时间单位为毫秒、长度单位为字节；这些流程参数存在默认值，实际定义和校验统一由 [api.lua](addon/modules/api.lua) 的 `plan(config)` 维护。它们不替代显式串口硬件配置。

串口打开、控制线设置和关闭行为分别由 [Linux terminal.py](addon/modules/runtime/terminal.py)、[Windows terminal.mjs](addon/modules/runtime/terminal.mjs) 与 [serial.ps1](addon/modules/runtime/serial.ps1) 实现。正常结束和异常退出都需要释放串口；运行中的串口占用或设备断开会向调用方传播，不自动切换端口。

## 在 xdtc action 中直接调用

配合 xdtc 0.11.0 的 action `entry` 使用，工具源码与 Addon 使用相同版本号。假定 `board.lua` 的 `tools.console` 已具备上面的配置字段：

```lua
-- xdtc.lua
return {
    data = "board.lua",
    actions = {
        console = {
            select = "tools.console",
            entry = function(config, api, ...)
                local console = import("@addon.x-console.api", {anonymous = true})
                return console.open(config)
            end,
        },
    },
}
```

```sh
xmake xdtc console
```

xdtc 负责展开和选择配置，插件负责打开终端，不需要单独的转发脚本。公开 Lua 接口是 `plan(config)` 与 `open(config)`；前者仅校验、补齐流程参数并返回独立配置，后者执行交互。action 的 `api` 和位置参数不会自动成为串口参数。

## 验证边界

在 Linux 的仓库根目录，使用已有运行环境执行：

```sh
xmake lua tests/api_run.lua
node tests/transport_run.mjs
uv run --no-project --no-sync python tests/test_linux.py
uv run --no-project --offline python tests/test_windows.py
```

公开合同、Windows JSON 传输模拟和 Linux 伪终端会话检查分别由 [api_run.lua](tests/api_run.lua)、[transport_run.mjs](tests/transport_run.mjs) 与 [test_linux.py](tests/test_linux.py) 提供。[test_windows.py](tests/test_windows.py) 使用真实终端 PTY 和模拟 Windows 串口进程，检查回车前的 Tab 转发、方向键/退格、任意字节、Ctrl+C 和异常退出后的终端恢复及串口关闭。这些是检查入口和运行方式，不是实板通过记录。

配置检查和模拟串口会话不能替代板卡上的完整交互验证。实板验证应确认输入、异步输出、Ctrl+C、串口重新打开及 DTR/RTS 行为；Windows 还需确认跨 WSL 的路径转换和进程退出。

2026-10-13 在 KY3133-B00 工程中，隔离安装后的插件通过 WSL 调用 Windows SerialPort，COM23／115200 下连续两次完成打开、`status()` 返回 STATUS、`ping` 返回 PONG 和关闭；xdtc 内联 entry 的行输入会话也收到 STATUS/PONG，并通过 EOF 正常退出。记录保存在该 MCU 工程的 `build/x-addon-hardware-evidence/console-0.log`、`console-1.log` 与 `entry-console.log`。Linux 本轮仅完成伪终端测试，未接真实串口；Windows Ctrl+C、控制线电气行为和物理上电未由这次会话验证。

许可证见 [LICENSE](LICENSE)。
