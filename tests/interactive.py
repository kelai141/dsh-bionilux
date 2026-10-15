"""Native glibc hook PTY regression; does not validate Android terminal policy."""
import os
import pty
import select
import signal
import sys
import termios
import time

root, preload, launcher = sys.argv[1:]
env = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/tmp",
    "TERM": "dumb",
    "PS1": "BN> ",
    "LD_PRELOAD": preload,
    "BIONILUX_PRELOAD": preload,
    "BIONILUX_BINARY_PATH": launcher,
    "BIONILUX_ROOTFS": root,
}
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(os.path.join(root, "tmp"))
    os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], env)


def prompt():
    data = bytearray()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        ready, _, _ = select.select([terminal], [], [], 0.2)
        if ready:
            data.extend(os.read(terminal, 4096))
            if data.endswith(b"BN> "):
                return bytes(data)
    raise AssertionError(f"PTY prompt timed out: {bytes(data)!r}")


def send(text):
    os.write(terminal, text)


finished = False
try:
    prompt()
    attrs = termios.tcgetattr(terminal)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(terminal, termios.TCSANOW, attrs)
    send(b"printf 'CWD:%s\\n' \"$PWD\"\n")
    assert b"CWD:/tmp\r\n" in prompt()
    send(b"/bin/sleep 30\n")
    time.sleep(0.3)
    send(b"\x03")
    prompt()
    send(b"printf 'STATUS:%s\\n' \"$?\"\n")
    assert b"STATUS:130\r\n" in prompt()
    send(b"/bin/sleep 30\n")
    time.sleep(0.3)
    send(b"\x1a")
    assert b"Stopped" in prompt()
    send(b"fg\n")
    time.sleep(0.3)
    send(b"\x03")
    prompt()
    send(b"exit 0\n")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
            finished = True
            break
        time.sleep(0.05)
    assert finished, "interactive shell did not exit"
finally:
    if not finished:
        foreground = os.tcgetpgrp(terminal)
        if foreground > 0 and foreground != pid:
            try:
                os.killpg(foreground, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(terminal)
print("native PTY cwd, Ctrl-C, Ctrl-Z, fg and clean exit: OK")
