"""Kernel bridge: launch a Jupyter kernel and own the handles that control it.

Two things a Node host cannot do without a helper:

1. **Interrupt on Windows.** ``ipykernel``'s ``interrupt_request`` handler is a
   no-op on Windows (``_send_interrupt_children`` only logs
   "Interrupt message not supported on Windows"). Interrupting a running cell
   there needs the Win32 event that ``jupyter_client.launch_kernel`` normally
   creates: the handle has to be made by a process that then spawns the kernel
   with handle inheritance, passing its numeric value to the kernel as
   ``JPY_INTERRUPT_EVENT``. Node has no FFI, so this script is that process. It
   mirrors what ``jupyter_client`` does without importing it, so any interpreter
   that can run ``ipykernel_launcher`` works even when ``jupyter_client`` itself
   is not installed.

2. **Leave no orphan.** A kernel that outlives the DSH host would hold a port, a
   process, and the user's variables forever. The kernel is spawned as a child of
   this bridge, and ``JPY_PARENT_PID`` is set to an inheritable handle to the
   bridge (Windows) or to the bridge pid (POSIX), so ipykernel's own parent poller
   shuts the kernel down the moment this bridge exits - including when Node is
   killed without running any cleanup.

Protocol: one JSON object per line on stdin, one per line on stdout.

  stdin   {"command": "interrupt" | "shutdown"}
  stdout  {"event": "ready", "pid": 1234}
  stdout  {"event": "interrupted", "signalled": true}
  stdout  {"event": "kernel-stdout" | "kernel-stderr", "text": "..."}
  stdout  {"event": "exit", "code": 0}
  stdout  {"event": "error", "message": "..."}        (fatal, exit follows)

Nothing in the protocol carries workspace file contents: the kernel's own IOPub
channel does that, over ZeroMQ, straight to the DSH host process.
"""

from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
import time

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000
# Give the kernel a moment to react to SIGTERM before it is killed outright.
TERMINATE_GRACE_POLLS = 40


def emit(payload: dict) -> None:
    """Write one protocol line to stdout, flushing so the host reads it at once."""
    try:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except Exception:
        # A closed stdout means the host is gone; exiting lets the kernel's own
        # parent watchdog reap the kernel.
        os._exit(1)


def one_line(error: BaseException) -> str:
    """A failure description safe to show: collapsed whitespace, bounded length."""
    return " ".join(str(error).split())[:240]


def read_stdin_lines(stream) -> "list[str]":  # noqa: ANN201 - simple helper
    if stream is None:
        return []
    lines = []
    for line in stream:
        lines.append(line)
    return lines


class WindowsEventInterrupter:
    """Create and signal the manual-reset event ipykernel's poller waits on."""

    def __init__(self) -> None:
        self.kernel32 = ctypes.windll.kernel32

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [
                ("nLength", ctypes.c_int),
                ("lpSecurityDescriptor", ctypes.c_void_p),
                ("bInheritHandle", ctypes.c_int),
            ]

        attributes = SecurityAttributes()
        attributes.nLength = ctypes.sizeof(SecurityAttributes)
        attributes.lpSecurityDescriptor = 0
        attributes.bInheritHandle = 1
        create_event = getattr(self.kernel32, "CreateEventW", self.kernel32.CreateEventA)
        create_event.restype = ctypes.c_void_p
        create_event.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p]
        # bManualReset=False matches jupyter_client: the poller resets the event
        # itself after each wait, so one request means one interrupt.
        self.handle = create_event(ctypes.byref(attributes), False, False, None)
        if not self.handle:
            raise OSError("CreateEvent returned no handle")
        self.set_event = self.kernel32.SetEvent
        self.set_event.restype = ctypes.c_int
        self.set_event.argtypes = [ctypes.c_void_p]

    def interrupt(self) -> bool:
        try:
            return bool(self.set_event(self.handle))
        except Exception as error:
            emit({"event": "warning", "message": f"interrupt failed: {one_line(error)}"})
            return False


def inheritable_self_handle() -> int:
    """A handle to this process that the kernel may inherit, for its watchdog."""
    kernel32 = ctypes.windll.kernel32
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.restype = ctypes.c_void_p
    duplicate = kernel32.DuplicateHandle
    duplicate.restype = ctypes.c_int
    duplicate.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ]
    target = ctypes.c_void_p(0)
    # dwOptions = DUPLICATE_SAME_ACCESS (2), bInheritHandle = TRUE (1).
    if not duplicate(get_current_process(), get_current_process(), get_current_process(),
                     ctypes.byref(target), 0, 1, 2):
        raise OSError("DuplicateHandle failed")
    return int(target.value or 0)


def build_environment() -> dict:
    """An environment for the kernel with our own handle variables set exclusively.

    ``JPY_*`` values inherited from some earlier launch would point the kernel at
    an event or a parent that no longer exists, so they are cleared first.
    """
    env = os.environ.copy()
    for name in ("JPY_INTERRUPT_EVENT", "IPY_INTERRUPT_EVENT", "JPY_PARENT_PID"):
        env.pop(name, None)
    # The kernel's own text must survive the transport; both channels are UTF-8.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def main(argv: "list[str]") -> int:  # noqa: ANN001 - entry point
    if len(argv) < 4:
        emit({"event": "error", "message": "usage: kernel-bridge <connection-file> <working-dir> <kernel-argv...>"})
        return 2
    connection_file = argv[1]
    # The kernel's working directory is the *notebook's* directory, which the host
    # knows and passes here: the connection file lives in a private temporary
    # directory of its own, so deriving cwd from it would resolve a cell's relative
    # paths (`open("data.csv")`) against the wrong folder.
    working_directory = argv[2]
    command = argv[3:]
    if not os.path.isdir(working_directory):
        emit({"event": "warning", "message": "kernel working directory is missing; using the connection directory"})
        working_directory = os.path.dirname(os.path.abspath(connection_file))

    env = build_environment()
    interrupter: WindowsEventInterrupter | None = None
    popen_kwargs: dict = {
        # Jupyter's own frontends start a kernel in the notebook's directory, so
        # relative paths inside a cell mean what the reader expects.
        "cwd": working_directory or None,
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }

    if IS_WINDOWS:
        try:
            interrupter = WindowsEventInterrupter()
            env["JPY_INTERRUPT_EVENT"] = str(interrupter.handle)
            env["IPY_INTERRUPT_EVENT"] = env["JPY_INTERRUPT_EVENT"]
            env["JPY_PARENT_PID"] = str(inheritable_self_handle())
        except Exception as error:
            # Degrade rather than fail: the cell still runs, only interrupt and the
            # watchdog are missing, and the host will still terminate on shutdown.
            emit({"event": "warning", "message": f"kernel watchdog unavailable: {one_line(error)}"})
        # bInheritHandles must be TRUE or the two handles above never reach the
        # kernel, so the launch disables close_fds exactly as launch_kernel does.
        popen_kwargs["close_fds"] = False
        popen_kwargs["creationflags"] = CREATE_NO_WINDOW
    else:
        env["JPY_PARENT_PID"] = str(os.getpid())
        # A new session means SIGINT can reach the whole group, which is what
        # jupyter_client relies on to interrupt a child process tree.
        popen_kwargs["start_new_session"] = True

    try:
        process = subprocess.Popen(command, **popen_kwargs)  # noqa: S603 - fixed argv, no shell
    except Exception as error:
        emit({"event": "error", "message": f"kernel launch failed: {one_line(error)}"})
        return 1

    def interrupt() -> bool:
        if interrupter is not None:
            return interrupter.interrupt()
        try:
            process.send_signal(signal.SIGINT)
            return True
        except Exception as error:
            emit({"event": "warning", "message": f"interrupt failed: {one_line(error)}"})
            return False

    def pipe_reader(stream, name: str) -> None:  # noqa: ANN001 - thread target
        # Kernel stdout is not cell output (that is IOPub's job); it is launch
        # noise, forwarded so the host can show a real reason for a failed start.
        try:
            for line in stream:
                text = line.rstrip("\r\n")
                if text:
                    emit({"event": "kernel-" + name, "text": text[:4000]})
        except Exception:
            pass

    if process.stdout is not None:
        threading.Thread(target=pipe_reader, args=(process.stdout, "stdout"), daemon=True).start()
    if process.stderr is not None:
        threading.Thread(target=pipe_reader, args=(process.stderr, "stderr"), daemon=True).start()

    def terminate() -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
        except Exception:
            pass
        for _ in range(TERMINATE_GRACE_POLLS):
            if process.poll() is not None:
                return
            time.sleep(0.05)
        try:
            process.kill()
        except Exception:
            pass

    emit({"event": "ready", "pid": process.pid})

    reported = threading.Event()

    def report_exit() -> None:
        code = process.wait()
        if not reported.is_set():
            reported.set()
            emit({"event": "exit", "code": code})

    threading.Thread(target=report_exit, daemon=True).start()

    try:
        stdin = sys.stdin
        if stdin is None:  # pythonw: no console, so no control channel.
            emit({"event": "warning", "message": "no control channel; kernel cannot be interrupted"})
            process.wait()
            return 0
        for line in stdin:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                request = json.loads(stripped)
            except ValueError:
                continue
            command_name = request.get("command") if isinstance(request, dict) else None
            if command_name == "interrupt":
                emit({"event": "interrupted", "signalled": interrupt()})
            elif command_name == "shutdown":
                break
            # Any other command is ignored: an older host must not kill a kernel.
    except Exception as error:
        emit({"event": "warning", "message": f"control pipe failed: {one_line(error)}"})
    finally:
        terminate()
        if not reported.is_set():
            reported.set()
            emit({"event": "exit", "code": process.poll()})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
