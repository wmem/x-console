import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Serial } from './transport.mjs';

if (process.argv[2] !== '--config' || !process.argv[3]) throw Error('请提供--config路径');
const file = process.argv[3];
const config = JSON.parse(await readFile(file, 'utf8'));
config.config_file = file;
const serial = new Serial(config);
const input = createInterface({ input: process.stdin });
const lines = [];
let stopping = false;
input.on('line', line => lines.push(line + '\n'));
input.on('close', () => { stopping = true; });
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
    await serial.open();
    process.stdout.write(`已打开 ${config.serial.port}；输入Shell命令，Ctrl+C退出。\n`);
    while (!stopping || lines.length) {
        process.stdout.write(await serial.exchange(lines.splice(0).join('')));
    }
} finally {
    input.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await serial.close();
}
