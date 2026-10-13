"""通过真实 PTY 验证串口交互和终端恢复；不访问板卡。"""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "addon/modules/runtime/terminal.py"
spec = importlib.util.spec_from_file_location("console_terminal", BACKEND)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


def read_until(fd, expected, timeout=4):
    data = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
        if ready:
            data.extend(os.read(fd, 4096))
            if expected in data:
                return bytes(data)
    raise AssertionError(f"等待 {expected!r} 超时，已收 {bytes(data)!r}")


class LinuxTerminalTests(unittest.TestCase):
    def serial_config(self, port):
        return {"port": port, "baud_rate": 115200, "data_bits": 8,
                "parity": "none", "stop_bits": 1, "flow_control": "none", "board_control": {}}

    def test_control_lines_only_explicit_values(self):
        with mock.patch.object(backend.fcntl, "ioctl") as ioctl:
            backend.set_lines(123, {})
            ioctl.assert_not_called()
            backend.set_lines(123, {"dtr": False, "rts": True})
            self.assertEqual(ioctl.call_args_list[0].args[:2], (123, termios.TIOCMBIC))
            self.assertEqual(ioctl.call_args_list[1].args[:2], (123, termios.TIOCMBIS))

    def test_unsupported_baud_fails_before_open(self):
        config = self.serial_config("/path/does/not/exist")
        config["baud_rate"] = 12345
        with self.assertRaisesRegex(ValueError, "波特率"):
            with backend.serial_port(config):
                self.fail("不应打开不支持的波特率")

    def test_real_pty_bidirectional_ctrl_c_and_terminal_restore(self):
        serial_master, serial_slave = os.openpty()
        terminal_master, terminal_slave = os.openpty()
        old_terminal = termios.tcgetattr(terminal_slave)
        # 后端明确防止关闭串口引发 HUPCL 及 RTS/CTS；其他属性应恢复。
        expected_serial = termios.tcgetattr(serial_slave)
        expected_serial[2] &= ~(termios.HUPCL | termios.CRTSCTS)
        process = None
        try:
            with tempfile.TemporaryDirectory(prefix="x-console 测试 ") as directory:
                config_path = Path(directory) / "config.json"
                config_path.write_text(json.dumps({"serial": self.serial_config(os.ttyname(serial_slave))}))
                process = subprocess.Popen([sys.executable, str(BACKEND), "--config", str(config_path)],
                                           stdin=terminal_slave, stdout=terminal_slave, stderr=terminal_slave)
                read_until(terminal_master, "Ctrl+C退出。".encode())
                deadline = time.monotonic() + 3
                while termios.tcgetattr(terminal_slave) == old_terminal and time.monotonic() < deadline:
                    time.sleep(0.005)
                self.assertNotEqual(termios.tcgetattr(terminal_slave), old_terminal)
                os.write(terminal_master, b"ping hello\r")
                self.assertIn(b"ping hello\r", read_until(serial_master, b"ping hello\r"))
                os.write(serial_master, b"board response\r\n")
                self.assertIn(b"board response\r\n", read_until(terminal_master, b"board response\r\n"))
                os.write(terminal_master, b"before-stop\x03after-stop")
                self.assertEqual(process.wait(timeout=4), 0)
                self.assertEqual(termios.tcgetattr(terminal_slave), old_terminal)
                self.assertEqual(termios.tcgetattr(serial_slave), expected_serial)
                self.assertEqual(read_until(serial_master, b"before-stop"), b"before-stop")
                self.assertFalse(select.select([serial_master], [], [], 0.05)[0], "Ctrl+C 后不应继续发送")
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            for fd in (serial_master, serial_slave, terminal_master, terminal_slave):
                os.close(fd)

    def test_noninteractive_stdin_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"serial": self.serial_config("unused")}))
            result = subprocess.run([sys.executable, str(BACKEND), "--config", str(path)],
                                    input=b"", capture_output=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("请在交互终端运行", result.stderr.decode())


if __name__ == "__main__":
    unittest.main()
