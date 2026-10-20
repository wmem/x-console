"""通过真实终端PTY及模拟Windows串口进程验证字节转发，不访问板卡。"""
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import termios
import unittest

from test_linux import read_until

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = ROOT / "addon/modules/runtime/terminal.mjs"
NODE = shutil.which("node")
FAKE = r"""
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('-Config') + 1], 'utf8'));
const audit = value => appendFileSync(config.audit_file, JSON.stringify(value) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
audit({opened: true});
emit({ready: true});
const input = createInterface({input: process.stdin});
input.on('line', line => {
    const request = JSON.parse(line);
    audit(request);
    const bytes = Buffer.from(request.bytes, 'base64');
    if (config.fake_mode === 'reject' && bytes.length) emit({ok: false, error: '模拟串口断开'});
    else emit({ok: true, bytes: request.bytes});
});
input.on('close', () => audit({closed: true}));
"""


class WindowsTerminalTests(unittest.TestCase):
    def config(self, directory, mode="echo"):
        directory = Path(directory)
        powershell = directory / "fake-powershell.mjs"
        powershell.write_text(f"#!{NODE}\n{FAKE}")
        powershell.chmod(0o700)
        wslpath = directory / "fake-wslpath.mjs"
        wslpath.write_text(f"#!{NODE}\nprocess.stdout.write(process.argv[3]);")
        wslpath.chmod(0o700)
        audit = directory / "audit.jsonl"
        config = directory / "config.json"
        config.write_text(json.dumps({
            "mode": "raw", "host": "windows", "fake_mode": mode,
            "runtime": {"powershell": str(powershell), "wslpath": str(wslpath)},
            "audit_file": str(audit), "serial": {"port": "COM23"},
            "poll_ms": 5, "rpc_timeout_ms": 1000, "close_timeout_ms": 500,
            "max_receive_bytes": 65536,
        }))
        return config, audit

    @contextmanager
    def session(self, mode="echo"):
        master, slave = os.openpty()
        original = termios.tcgetattr(slave)
        child = None
        try:
            with tempfile.TemporaryDirectory(prefix="x-console Windows PTY ") as directory:
                config, audit = self.config(directory, mode)
                child = subprocess.Popen([NODE, str(TERMINAL), "--config", str(config)],
                                         stdin=slave, stdout=slave, stderr=slave)
                read_until(master, "按字节转发".encode())
                self.assertNotEqual(termios.tcgetattr(slave), original)
                yield child, master, slave, original, audit
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            os.close(master)
            os.close(slave)

    def records(self, audit):
        return [json.loads(line) for line in audit.read_text().splitlines()]

    def sent(self, audit):
        return b"".join(base64.b64decode(record["bytes"])
                        for record in self.records(audit) if "bytes" in record)

    def test_tab_before_enter_controls_binary_and_ctrl_c_restore(self):
        with self.session() as (child, master, slave, original, audit):
            # 没有回车也必须收到Tab；PTY输出关闭本地回显，回传来自模拟串口。
            first = b"sta\t"
            os.write(master, first)
            self.assertIn(first, read_until(master, first))
            self.assertEqual(self.sent(audit), first)
            controls = b"\x1b[A\x1b[B\x08\x7f\r\x00\xff\xe4"
            os.write(master, controls)
            self.assertIn(controls, read_until(master, controls))
            os.write(master, b"\xb8\xad")
            self.assertIn(b"\xb8\xad", read_until(master, b"\xb8\xad"))
            os.write(master, b"before-stop\x03after-stop")
            self.assertEqual(child.wait(timeout=4), 0)
            self.assertEqual(termios.tcgetattr(slave), original)
            self.assertEqual(self.sent(audit), first + controls + b"\xb8\xadbefore-stop")
            self.assertTrue(self.records(audit)[-1]["closed"])

    def test_backend_failure_restores_terminal_and_closes_serial(self):
        with self.session("reject") as (child, master, slave, original, audit):
            os.write(master, b"x")
            read_until(master, "模拟串口断开".encode())
            self.assertNotEqual(child.wait(timeout=4), 0)
            self.assertEqual(termios.tcgetattr(slave), original)
            self.assertTrue(self.records(audit)[-1]["closed"])

    def test_sigterm_restores_terminal_and_closes_serial(self):
        with self.session() as (child, master, slave, original, audit):
            child.send_signal(signal.SIGTERM)
            self.assertEqual(child.wait(timeout=4), 0)
            self.assertEqual(termios.tcgetattr(slave), original)
            self.assertTrue(self.records(audit)[-1]["closed"])

    def test_noninteractive_raw_rejected_before_open(self):
        with tempfile.TemporaryDirectory() as directory:
            config, audit = self.config(directory)
            result = subprocess.run([NODE, str(TERMINAL), "--config", str(config)],
                                    input=b"", capture_output=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("请在交互终端运行", result.stderr.decode())
            self.assertFalse(audit.exists())


if __name__ == "__main__":
    unittest.main()
