-- 显式配置合同及计划阶段无执行副作用回归。
local root = os.curdir()
local api = import("api", {rootdir = path.join(root, "addon/modules"), anonymous = true})
local raw_pcall = debug.global("pcall")
local passed, failed = 0, 0

local function fixture(host)
    return {
        host = host or "linux", mode = host == "windows" and "line" or "raw",
        runtime = {python = {program = "uv", args = {"run", "--offline", "python"}},
            node = "node", powershell = "PowerShell.exe", wslpath = "wslpath"},
        serial = {port = host == "windows" and "COM23" or "/dev/ttyUSB0", baud_rate = 115200,
            data_bits = 8, parity = "none", stop_bits = 1, flow_control = "none", board_control = {}},
    }
end

local function test(name, callback)
    local ok, errors = raw_pcall(callback)
    if ok then passed = passed + 1; print("[PASS] %s", name)
    else failed = failed + 1; print("[FAIL] %s: %s", name, errors) end
end

test("计划补全时限且不修改调用方配置", function()
    local original = fixture()
    local planned = api.plan(original)
    assert(planned.poll_ms == 100 and planned.rpc_timeout_ms == 15000)
    assert(original.poll_ms == nil and original.rpc_timeout_ms == nil)
    assert(original.serial.port == "/dev/ttyUSB0" and #original.runtime.python.args == 3)
    planned.serial.port = "changed"
    planned.runtime.python.args[1] = "changed"
    assert(original.serial.port == "/dev/ttyUSB0" and original.runtime.python.args[1] == "run")
end)

test("公开执行入口定位运行资源并清理临时配置", function()
    local directory = os.tmpfile() .. "-x-console-test"
    os.mkdir(directory)
    local capture = path.join(directory, "capture.py")
    local record = path.join(directory, "record.txt")
    io.writefile(capture, [[import sys
from pathlib import Path
assert Path(sys.argv[2]).is_file(), sys.argv[2]
assert sys.argv[3] == '--config'
assert Path(sys.argv[4]).is_file()
Path(sys.argv[1]).write_text(sys.argv[4])
]])
    local value = fixture()
    value.runtime.python = {program = "uv", args = {"run", "--offline", "python", capture, record}}
    local ok, errors = raw_pcall(function()
        api.open(value)
        local config_file = io.readfile(record)
        assert(config_file and not os.exists(config_file), "执行后临时配置未删除")
    end)
    os.rm(directory)
    assert(ok, tostring(errors))
end)

test("后端失败必须传播且仍清理临时配置", function()
    local directory = os.tmpfile() .. "-x-console-failure"
    os.mkdir(directory)
    local capture = path.join(directory, "fail.py")
    local record = path.join(directory, "record.txt")
    io.writefile(capture, [[import sys
from pathlib import Path
Path(sys.argv[1]).write_text(sys.argv[4])
raise SystemExit(7)
]])
    local value = fixture()
    value.runtime.python = {program = "uv", args = {"run", "--offline", "python", capture, record}}
    local ok, errors = raw_pcall(function()
        local executed = raw_pcall(function() api.open(value) end)
        assert(not executed, "后端非零退出被吞掉")
        local config_file = io.readfile(record)
        assert(config_file and not os.exists(config_file), "失败后临时配置未删除")
    end)
    os.rm(directory)
    assert(ok, tostring(errors))
end)

test("Windows 与显式控制线、Linux 字符串 Python 可独立计划", function()
    local windows = fixture("windows")
    windows.serial.board_control = {dtr = false, rts = true}
    assert(api.plan(windows).serial.board_control.rts == true)
    local linux = fixture()
    linux.runtime.python = "python3"
    assert(api.plan(linux).runtime.python == "python3")
end)

test("时限保留调用方值", function()
    local value = fixture()
    value.poll_ms, value.rpc_timeout_ms, value.max_receive_bytes = 5, 20, 16
    local planned = api.plan(value)
    assert(planned.poll_ms == 5 and planned.rpc_timeout_ms == 20 and planned.max_receive_bytes == 16)
end)

test("必需参数缺失和类型错误在执行前拒绝", function()
    local changes = {
        function(c) c.host = nil end, function(c) c.host = "auto" end,
        function(c) c.runtime = nil end, function(c) c.serial = nil end,
        function(c) c.serial.port = "" end, function(c) c.serial.baud_rate = 0 end,
        function(c) c.serial.baud_rate = 1.5 end, function(c) c.serial.baud_rate = "115200" end,
        function(c) c.mode = "line" end, function(c) c.serial.data_bits = 7 end,
        function(c) c.serial.parity = "even" end, function(c) c.serial.stop_bits = 2 end,
        function(c) c.serial.flow_control = "rtscts" end, function(c) c.serial.board_control = nil end,
        function(c) c.serial.board_control = {dtr = 0} end,
        function(c) c.serial.board_control = {reset = false} end,
        function(c) c.runtime.python = nil end,
        function(c) c.runtime.python = {program = "python3", args = "--offline"} end,
        function(c) c.runtime.python.args = {flag = "--offline"} end,
        function(c) c.runtime.python.args = {42} end,
        function(c) c.runtime.python.args = {[0] = "run"} end,
        function(c) c.runtime.python.args = {[1] = "run", [3] = "python", [4] = "script.py"} end,
        function(c) c.runtime.python.args = {"run", "--offline", "python", "script.py"}; c.runtime.python.args[3] = nil end,
        function(c) c.poll_ms = 0 end, function(c) c.write_timeout_ms = -1 end,
        function(c) c.close_timeout_ms = 0.5 end, function(c) c.max_receive_bytes = "16" end,
        function(c) c.poll_ms = 10001; c.rpc_timeout_ms = 20000 end,
        function(c) c.poll_ms = 100; c.rpc_timeout_ms = 100 end,
    }
    assert(not raw_pcall(function() api.plan(nil) end))
    for index, change in ipairs(changes) do
        local value = fixture()
        change(value)
        assert(not raw_pcall(function() api.plan(value) end), "未拒绝错误配置 " .. index)
    end
    for _, key in ipairs({"node", "powershell", "wslpath"}) do
        local value = fixture("windows")
        value.runtime[key] = nil
        assert(not raw_pcall(function() api.plan(value) end), "未拒绝缺少 " .. key)
    end
    local value = fixture("windows")
    value.mode = "raw"
    assert(not raw_pcall(function() api.plan(value) end))
end)

print("x-console.api tests: %d passed, %d failed", passed, failed)
assert(failed == 0, "x-console 配置测试失败")
