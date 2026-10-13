task("x-console")
set_category("plugin")
set_menu({usage = "xmake x-console --config=<JSON> [--dry-run]",
    description = "按显式配置打开串口终端",
    options = {{"c", "config", "kv", nil, "串口配置 JSON"},
        {nil, "dry-run", "k", nil, "只验证并输出配置，不打开串口"}}})
on_run("main")
