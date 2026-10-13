"""Linux逐字符终端；串口和控制线均来自config，Ctrl+C由本机消费。"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import struct
import sys
import termios
import tty


def set_lines(fd, control):
    for key, flag in (("dtr", termios.TIOCM_DTR), ("rts", termios.TIOCM_RTS)):
        if key in control:
            fcntl.ioctl(fd, termios.TIOCMBIS if control[key] else termios.TIOCMBIC, struct.pack("I", flag))


@contextlib.contextmanager
def serial_port(config):
    speed = getattr(termios, f'B{config["baud_rate"]}', None)
    if speed is None:
        raise ValueError(f'系统不支持串口波特率 {config["baud_rate"]}')
    fd = os.open(config["port"], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    old = None
    try:
        old = termios.tcgetattr(fd)
        set_lines(fd, config["board_control"])
        attributes = termios.tcgetattr(fd)
        attributes[:6] = [0, 0, termios.CS8 | termios.CLOCAL | termios.CREAD, 0, speed, speed]
        attributes[6][termios.VMIN] = attributes[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attributes)
        termios.tcflush(fd, termios.TCIOFLUSH)
        yield fd
    finally:
        try:
            if old is not None:
                old[2] &= ~(termios.HUPCL | termios.CRTSCTS)
                termios.tcsetattr(fd, termios.TCSANOW, old)
                set_lines(fd, config["board_control"])
        finally:
            os.close(fd)


def terminal(config):
    stdin = sys.stdin.fileno()
    if not os.isatty(stdin):
        raise ValueError("请在交互终端运行")
    old = termios.tcgetattr(stdin)
    with serial_port(config["serial"]) as fd:
        print(f'{config["serial"]["port"]}；{config["serial"]["baud_rate"]} 8N1；Ctrl+C退出。', flush=True)
        try:
            tty.setraw(stdin)
            while True:
                readable, _, _ = select.select([stdin, fd], [], [])
                if fd in readable:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                if stdin in readable:
                    data = os.read(stdin, 4096)
                    if not data:
                        break
                    data, stop, _ = data.partition(b"\x03")
                    while data:
                        select.select([], [fd], [])
                        data = data[os.write(fd, data):]
                    if stop:
                        break
        finally:
            termios.tcsetattr(stdin, termios.TCSANOW, old)
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    terminal(json.loads(Path(args.config).read_text()))
