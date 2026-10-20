import("core.base.json")
local resources = path.join(os.scriptdir(), "runtime")

local function copy(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = copy(item) end
    return result
end

local function text(value, field)
    assert(type(value) == "string" and #value > 0, "x-console: 请配置 " .. field)
end

local function arguments(value)
    if value == nil then return end
    assert(type(value) == "table", "x-console: python.args 必须为字符串数组")
    for key, item in pairs(value) do
        assert(type(key) == "number" and key >= 1 and key <= #value and key % 1 == 0
            and type(item) == "string", "x-console: python.args 必须为连续字符串数组")
    end
end

function plan(config)
    assert(type(config) == "table", "x-console: config 必须为 table")
    local c = copy(config)
    assert(c.host == "linux" or c.host == "windows", "x-console: host 必须为 linux/windows")
    assert(type(c.runtime) == "table", "x-console: 请配置 runtime")
    assert(type(c.serial) == "table", "x-console: 请配置 serial")
    text(c.serial.port, "serial.port")
    local baud = c.serial.baud_rate
    assert(type(baud) == "number" and baud > 0 and baud % 1 == 0, "x-console: baud_rate 必须为正整数")
    assert(c.serial.data_bits == 8 and c.serial.parity == "none" and c.serial.stop_bits == 1
        and c.serial.flow_control == "none", "x-console: 当前合同为显式配置的8N1/无流控")
    assert(type(c.serial.board_control) == "table", "x-console: 请显式配置 serial.board_control（可为空表）")
    for key, value in pairs(c.serial.board_control) do
        assert((key == "dtr" or key == "rts") and type(value) == "boolean", "x-console: 控制线只接受dtr/rts布尔值")
    end
    if c.host == "windows" then
        assert(c.mode == "line" or c.mode == "raw", "x-console: Windows 后端支持 mode=line/raw")
        text(c.runtime.node, "runtime.node")
        text(c.runtime.powershell, "runtime.powershell")
        if os.host() ~= "windows" then text(c.runtime.wslpath, "runtime.wslpath") end
    else
        assert(os.host() == "linux", "x-console: Linux 后端需要 Linux 执行环境")
        assert(c.mode == "raw", "x-console: Linux 后端当前支持 mode=raw")
        local python = c.runtime.python
        if type(python) == "table" then
            text(python.program, "runtime.python.program")
            arguments(python.args)
        else text(python, "runtime.python") end
    end
    for key, default in pairs({poll_ms = 100, write_timeout_ms = 2000, rpc_timeout_ms = 15000,
        close_timeout_ms = 3000, max_receive_bytes = 65536}) do
        if c[key] == nil then c[key] = default end
        assert(type(c[key]) == "number" and c[key] > 0 and c[key] % 1 == 0, "x-console: " .. key .. " 必须为正整数")
    end
    assert(c.poll_ms <= 10000 and c.rpc_timeout_ms > c.poll_ms, "x-console: poll_ms/rpc_timeout_ms 不兼容")
    return c
end

function open(config)
    local c = plan(config)
    local directory = os.tmpfile() .. "-x-console"
    os.mkdir(directory)
    try({function()
        local file = path.join(directory, "config.json")
        json.savefile(file, c, {indent = true})
        if c.host == "windows" then
            os.execv(c.runtime.node, {path.join(resources, "terminal.mjs"), "--config", file})
        else
            local python = c.runtime.python
            local program = type(python) == "table" and python.program or python
            local args = type(python) == "table" and table.clone(python.args or {}) or {}
            table.join2(args, {path.join(resources, "terminal.py"), "--config", file})
            os.execv(program, args)
        end
    end, finally({function(ok, errors)
        os.tryrm(directory)
        if not ok then raise(errors) end
    end})})
end
