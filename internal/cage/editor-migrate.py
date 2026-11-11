#!/usr/bin/python3
"""Stop only the legacy Cage editor before systemd takes ownership."""
import os
from pathlib import Path
import pwd
import select
import signal
import sys

NODE = '/usr/lib/code-server/lib/node'
ROOT = '/usr/lib/code-server'
ENTRY = '/usr/lib/code-server/out/node/entry.js'
CONFIG = '/home/cage/.config/claude-cage/code-server.yaml'


def is_legacy_editor(argv, executable, uid, cage_uid):
    if uid != cage_uid or executable != str(Path(NODE).resolve()):
        return False
    if len(argv) < 2 or argv[1] not in (ROOT, ENTRY):
        return False
    def value(flag):
        try:
            return argv[argv.index(flag) + 1]
        except (ValueError, IndexError):
            return None
    return value('--config') == CONFIG and value('--bind-addr') == '127.0.0.1:18080'


def main():
    cage_uid = pwd.getpwnam('cage').pw_uid
    for binary in (NODE, ENTRY):
        st = os.stat(binary)
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Не удалось подтвердить подлинность программы редактора; существующий процесс не остановлен')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('Система не поддерживает безопасное определение старого процесса редактора; существующий процесс не остановлен')
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        handle = None
        try:
            handle = os.pidfd_open(int(proc.name))
            if 'cage-editor.service' in (proc / 'cgroup').read_text():
                continue
            argv = (proc / 'cmdline').read_bytes().decode(errors='replace').rstrip('\0').split('\0')
            if not is_legacy_editor(argv, os.readlink(proc / 'exe'), proc.stat().st_uid, cage_uid):
                continue
            signal.pidfd_send_signal(handle, signal.SIGTERM)
            exited = select.poll()
            exited.register(handle, select.POLLIN)
            if not exited.poll(5000):
                signal.pidfd_send_signal(handle, signal.SIGKILL)
                if not exited.poll(2000):
                    raise RuntimeError('Старый редактор ещё не завершился. Повторите попытку позже')
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        finally:
            if handle is not None:
                os.close(handle)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
