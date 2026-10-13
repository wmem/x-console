// Windows持有COM口；配置和文本由JSON传递，不经shell拼接。
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function windowsPath(config, file) {
    if (process.platform === 'win32') return file;
    return execFileSync(config.runtime.wslpath, ['-w', file], { encoding: 'utf8' }).trim();
}

export class Serial {
    constructor(config) {
        this.config = config;
        this.pending = [];
        this.messages = [];
        this.stderr = '';
        this.busy = false;
        this.child = spawn(config.runtime.powershell, [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', windowsPath(config, fileURLToPath(new URL('./serial.ps1', import.meta.url))),
            '-Config', windowsPath(config, config.config_file),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-16384); });
        this.child.stdin.on('error', error => this.fail(error));
        createInterface({ input: this.child.stdout }).on('line', line => {
            try {
                const message = JSON.parse(line.replace(/^\uFEFF/, ''));
                const waiter = this.pending.shift();
                if (waiter) waiter.resolve(message);
                else if (this.messages.length < 4) this.messages.push(message);
                else throw Error('串口返回过多未请求响应');
            } catch (error) { this.fail(error); }
        });
        this.child.on('error', error => this.fail(error));
        this.child.on('exit', (code, signal) => this.fail(Error(`串口进程退出 ${code ?? signal}: ${this.stderr}`)));
    }

    fail(error) {
        this.failure ??= error;
        for (const waiter of this.pending.splice(0)) waiter.reject(this.failure);
    }

    next() {
        if (this.failure) return Promise.reject(this.failure);
        if (this.messages.length) return Promise.resolve(this.messages.shift());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(Error('串口RPC超时'));
                this.child.kill();
            }, this.config.rpc_timeout_ms);
            this.pending.push({
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
        });
    }

    async open() {
        const message = await this.next();
        if (!message.ready) throw Error(message.error ?? '串口未就绪');
    }

    async exchange(text = '', waitMs = this.config.poll_ms) {
        if (this.busy) throw Error('串口只允许一笔在途事务');
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw Error('waitMs超界');
        this.busy = true;
        try {
            const received = this.next();
            this.child.stdin.write(JSON.stringify({ text, waitMs }) + '\n');
            const message = await received;
            if (!message.ok) throw Error(message.error);
            return message.text;
        } finally { this.busy = false; }
    }

    async close() {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        const exited = new Promise(resolve => this.child.once('exit', resolve));
        this.child.stdin.end();
        const timer = setTimeout(() => this.child.kill(), this.config.close_timeout_ms);
        try { await exited; } finally { clearTimeout(timer); }
    }
}
