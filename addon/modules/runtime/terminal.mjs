import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Serial } from './transport.mjs';

if (process.argv[2] !== '--config' || !process.argv[3]) throw Error('请提供--config路径');
const file = process.argv[3];
const config = JSON.parse(await readFile(file, 'utf8'));
config.config_file = file;
const raw = config.mode === 'raw';
if (!raw && config.mode !== 'line') throw Error('Windows终端仅支持mode=line/raw');
if (raw && (!process.stdin.isTTY || !process.stdin.setRawMode)) throw Error('请在交互终端运行raw控制台');
const wasRaw = process.stdin.isRaw;
const chunks = [];
let stopping = false;
const stop = () => { stopping = true; };
const forward = chunk => {
    if (stopping) return;
    const end = chunk.indexOf(3);
    const bytes = end < 0 ? chunk : chunk.subarray(0, end);
    if (bytes.length) chunks.push(bytes);
    if (end >= 0) stop(); // Ctrl+C由本机消费，同一批后续输入不再转发。
};
let serial, input;
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
    if (raw) {
        process.stdin.setRawMode(true);
        process.stdin.on('data', forward);
        process.stdin.on('end', stop);
        process.stdin.resume();
    } else {
        input = createInterface({ input: process.stdin });
        input.on('line', line => chunks.push(line + '\n'));
        input.on('close', stop);
    }
    serial = new Serial(config);
    await serial.open();
    process.stdout.write(`已打开 ${config.serial.port}；${raw ? '按字节转发' : '输入Shell命令'}，Ctrl+C退出。\n`);
    while (!stopping || chunks.length) {
        process.stdout.write(raw
            ? await serial.exchangeBytes(Buffer.concat(chunks.splice(0)))
            : await serial.exchange(chunks.splice(0).join('')));
    }
} finally {
    if (raw) {
        process.stdin.off('data', forward);
        process.stdin.off('end', stop);
        process.stdin.setRawMode(Boolean(wasRaw));
        process.stdin.pause();
    } else {
        input?.close();
    }
    await serial?.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
}
