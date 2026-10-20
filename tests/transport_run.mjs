// 真实子进程、stdin/stdout RPC；用假 PowerShell 验证，不访问串口。
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Serial } from '../addon/modules/runtime/transport.mjs';

const fakePowerShell = `
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const index = process.argv.indexOf('-Config');
const config = JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
const mode = config.fake_mode;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
appendFileSync(config.audit_file, JSON.stringify({argv: process.argv.slice(2), serial: config.serial}) + '\\n');
if (mode === 'exit') { process.stderr.write('fake PowerShell failure'); process.exit(7); }
if (mode !== 'neverready') emit(mode === 'notready' ? {ready: false, error: 'port unavailable'} : {ready: true});
const input = createInterface({input: process.stdin});
input.on('line', line => {
    const request = JSON.parse(line);
    appendFileSync(config.audit_file, JSON.stringify(request) + '\\n');
    if (mode === 'noreply') return;
    if (mode === 'malformed') { process.stdout.write('invalid-json\\n'); return; }
    if (mode === 'reject') { emit({ok: false, error: 'write failed'}); return; }
    if (mode === 'missingbytes') { emit({ok: true, text: ''}); return; }
    const response = () => emit('bytes' in request
        ? {ok: true, bytes: request.bytes} : {ok: true, text: request.text});
    if (mode === 'slowreply') setTimeout(response, 80);
    else response();
});
input.on('close', () => { if (mode === 'ignoreeof') setInterval(() => {}, 1000); });
`;

async function fixture(t, mode = 'echo') {
    const directory = await mkdtemp(join(tmpdir(), 'x-console 测试 $() '));
    const powershell = join(directory, 'fake-powershell.mjs');
    const wslpath = join(directory, 'fake-wslpath.mjs');
    const configFile = join(directory, 'config.json');
    const audit = join(directory, 'audit.jsonl');
    await writeFile(powershell, `#!${process.execPath}\n${fakePowerShell}`, {mode: 0o700});
    await writeFile(wslpath, `#!${process.execPath}\nprocess.stdout.write(process.argv[3]);`, {mode: 0o700});
    const config = {host: 'windows', mode: 'line',
        runtime: {powershell, wslpath}, config_file: configFile, audit_file: audit,
        serial: {port: 'COM23', baud_rate: 115200, board_control: {dtr: false, rts: true}},
        poll_ms: 5, rpc_timeout_ms: 1000, close_timeout_ms: 100, max_receive_bytes: 65536, fake_mode: mode};
    await writeFile(configFile, JSON.stringify(config));
    const serial = new Serial(config);
    t.after(async () => {
        await serial.close();
        await rm(directory, {recursive: true, force: true});
    });
    return {serial, config, audit: async () => (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse)};
}

test('完整配置由文件传递；Unicode 与 shell 字符按 JSON 往返', async t => {
    const {serial, audit} = await fixture(t);
    await serial.open();
    const text = 'status()\n中文 $HOME $(echo should-not-run) `uname` "quote"\r\n';
    assert.equal(await serial.exchange(text, 8), text);
    const records = await audit();
    assert.deepEqual(records[0].serial.board_control, {dtr: false, rts: true});
    assert.equal(records[0].serial.baud_rate, 115200);
    assert.equal(records[1].text, text);
    assert.equal(records[1].waitMs, 8);
    assert.ok(records[0].argv.includes('-NoProfile'));
});

test('空闲交换采用 config.poll_ms，正常 close 回收进程', async t => {
    const {serial, config, audit} = await fixture(t);
    await serial.open();
    assert.equal(await serial.exchange(), '');
    assert.equal((await audit())[1].waitMs, config.poll_ms);
    await serial.close();
    assert.ok(serial.child.exitCode !== null || serial.child.signalCode !== null);
    await serial.close();
});

test('字节通道完整往返0..255及空输入，不通过UTF-8解码', async t => {
    const {serial, audit} = await fixture(t);
    await serial.open();
    const bytes = Buffer.from(Array.from({length: 256}, (_, i) => i));
    assert.deepEqual(await serial.exchangeBytes(bytes, 0), bytes);
    assert.deepEqual(await serial.exchangeBytes(), Buffer.alloc(0));
    const records = await audit();
    assert.equal(records[1].bytes, bytes.toString('base64'));
    assert.equal(records[1].text, undefined);
    assert.equal(records[2].bytes, '');
    await assert.rejects(serial.exchangeBytes('not bytes'), /字节数组/);
});

test('拒绝同时在途的第二笔交换', async t => {
    const {serial} = await fixture(t, 'slowreply');
    await serial.open();
    const first = serial.exchange('first');
    await assert.rejects(serial.exchange('second'), /一笔在途/);
    assert.equal(await first, 'first');
    assert.equal(await serial.exchange('after'), 'after');
});

test('字节通道与文本通道共享在途限制', async t => {
    const {serial} = await fixture(t, 'slowreply');
    await serial.open();
    const first = serial.exchangeBytes(Buffer.from([9, 0xff]));
    await assert.rejects(serial.exchange('second'), /一笔在途/);
    assert.deepEqual(await first, Buffer.from([9, 0xff]));
});

test('字节响应缺字段及超过接收上限时明确报错', async t => {
    const {serial} = await fixture(t, 'missingbytes');
    await serial.open();
    await assert.rejects(serial.exchangeBytes(), /缺少bytes/);
    const normal = await fixture(t);
    await normal.serial.open();
    normal.config.max_receive_bytes = 1;
    await assert.rejects(normal.serial.exchangeBytes(Buffer.from([0, 0xff])), /response too long/);
});

test('越界等待时间在发送前拒绝', async t => {
    const {serial, audit} = await fixture(t);
    await serial.open();
    for (const wait of [-1, 10001, 0.5, NaN]) await assert.rejects(serial.exchange('bad', wait), /waitMs/);
    assert.equal((await audit()).length, 1);
    assert.equal(await serial.exchange('valid', 0), 'valid');
});

test('打开失败传播 PowerShell 错误', async t => {
    const {serial} = await fixture(t, 'notready');
    await assert.rejects(serial.open(), /port unavailable/);
});

test('进程提前退出传播状态及 stderr', async t => {
    const {serial} = await fixture(t, 'exit');
    await assert.rejects(serial.open(), /退出 7: fake PowerShell failure/);
});

test('PowerShell 程序不存在时传播启动错误', async t => {
    const {serial, config} = await fixture(t);
    await serial.close();
    config.runtime.powershell = join(tmpdir(), 'x-console-does-not-exist-powershell');
    const missing = new Serial(config);
    t.after(() => missing.close());
    await assert.rejects(missing.open(), /ENOENT/);
    await missing.close();
});

test('错误 JSON 拒绝当前和后续交换', async t => {
    const {serial} = await fixture(t, 'malformed');
    await serial.open();
    await assert.rejects(serial.exchange('x'), SyntaxError);
    await assert.rejects(serial.exchange('again'), SyntaxError);
});

test('RPC 返回业务失败传播错误且允许后续交换', async t => {
    const {serial} = await fixture(t, 'reject');
    await serial.open();
    await assert.rejects(serial.exchange('x'), /write failed/);
    assert.equal(serial.busy, false);
});

test('就绪等待超时终止子进程', async t => {
    const {serial, config} = await fixture(t, 'neverready');
    config.rpc_timeout_ms = 120;
    await assert.rejects(serial.open(), /RPC超时/);
    await serial.close();
    assert.ok(serial.child.exitCode !== null || serial.child.signalCode !== null);
});

test('交换等待超时终止子进程', async t => {
    const {serial, config} = await fixture(t, 'noreply');
    await serial.open();
    config.rpc_timeout_ms = 100;
    await assert.rejects(serial.exchange('x'), /RPC超时/);
    await serial.close();
    assert.ok(serial.child.exitCode !== null || serial.child.signalCode !== null);
});

test('EOF 后不退出的进程由 close_timeout_ms 回收', async t => {
    const {serial} = await fixture(t, 'ignoreeof');
    await serial.open();
    const started = Date.now();
    await serial.close();
    assert.ok(Date.now() - started < 2000);
    assert.equal(serial.child.signalCode, 'SIGTERM');
});

test('Windows 控制台按行发送，stdin EOF 后处理完输入并退出', async t => {
    const {serial, config, audit} = await fixture(t);
    await serial.close();
    const terminal = fileURLToPath(new URL('../addon/modules/runtime/terminal.mjs', import.meta.url));
    const child = spawn(process.execPath, [terminal, '--config', config.config_file]);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = once(child, 'exit', {signal: AbortSignal.timeout(3000)});
    child.stdin.end('ping hello\n中文命令\n');
    const [code, signal] = await exited;
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
    assert.match(output, /已打开 COM23/);
    assert.match(output, /ping hello\n中文命令\n/);
    const records = await audit();
    assert.equal(records.filter(value => 'text' in value).map(value => value.text).join(''), 'ping hello\n中文命令\n');
});

test('Windows 控制台 SIGINT 结束轮询并回收进程', async t => {
    const {serial, config} = await fixture(t);
    await serial.close();
    const terminal = fileURLToPath(new URL('../addon/modules/runtime/terminal.mjs', import.meta.url));
    const child = spawn(process.execPath, [terminal, '--config', config.config_file]);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = once(child, 'exit', {signal: AbortSignal.timeout(3000)});
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('控制台未就绪')), 2000);
        child.stdout.on('data', data => {
            if (data.toString().includes('已打开')) { clearTimeout(timer); resolve(); }
        });
    });
    child.kill('SIGINT');
    const [code, signal] = await exited;
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
});
