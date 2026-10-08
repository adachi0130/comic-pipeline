"""仙宫云 SSH 隧道（本机端口转发到容器内的 ComfyUI）。

只在本机监听 ``127.0.0.1:local_port``，转发到远端 ``127.0.0.1:remote_port``，
**不暴露公网**。用 paramiko 手工实现端口转发，避免额外依赖。
"""

from __future__ import annotations

import select
import socket
import threading
from dataclasses import dataclass

try:  # paramiko 是可选依赖，未安装时隧道功能不可用
    import paramiko
except ImportError:  # pragma: no cover
    paramiko = None  # type: ignore[assignment]


@dataclass
class TunnelStatus:
    running: bool
    local_port: int
    error: str = ""


class SshTunnel:
    """一个简单的前向隧道：localhost:local_port -> ssh_host -> 127.0.0.1:remote_port。"""

    def __init__(
        self,
        *,
        ssh_host: str,
        ssh_port: int,
        ssh_user: str,
        local_port: int,
        remote_port: int,
        ssh_key_path: str = "",
        ssh_password: str = "",
    ) -> None:
        self.ssh_host = ssh_host
        self.ssh_port = ssh_port
        self.ssh_user = ssh_user
        self.local_port = local_port
        self.remote_port = remote_port
        self.ssh_key_path = ssh_key_path
        self.ssh_password = ssh_password

        self._client: "paramiko.SSHClient | None" = None
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._error = ""

    # ---------------- 生命周期 ----------------
    def start(self) -> TunnelStatus:
        if paramiko is None:
            return TunnelStatus(False, self.local_port, "未安装 paramiko，无法建立隧道")
        if self._thread and self._thread.is_alive():
            return TunnelStatus(True, self.local_port)

        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            kwargs: dict = dict(
                hostname=self.ssh_host,
                port=self.ssh_port,
                username=self.ssh_user,
                timeout=15,
            )
            if self.ssh_key_path:
                kwargs["key_filename"] = self.ssh_key_path
            if self.ssh_password:
                kwargs["password"] = self.ssh_password
            client.connect(**kwargs)
            self._client = client

            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", self.local_port))
            server.listen(16)
            server.settimeout(1.0)
            self._server = server
        except Exception as e:  # noqa: BLE001 - 统一转成状态返回
            self._error = str(e)
            return TunnelStatus(False, self.local_port, str(e))

        self._stop.clear()
        self._thread = threading.Thread(target=self._accept_loop, name="ssh-tunnel", daemon=True)
        self._thread.start()
        return TunnelStatus(True, self.local_port)

    def stop(self) -> None:
        self._stop.set()
        if self._server:
            try:
                self._server.close()
            except OSError:
                pass
            self._server = None
        if self._client:
            try:
                self._client.close()
            except Exception:  # noqa: BLE001
                pass
            self._client = None
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None

    def status(self) -> TunnelStatus:
        alive = bool(self._thread and self._thread.is_alive())
        return TunnelStatus(alive, self.local_port, self._error)

    # ---------------- 内部 ----------------
    def _accept_loop(self) -> None:
        assert self._server is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        if self._client is None:
            conn.close()
            return
        try:
            transport = self._client.get_transport()
            if transport is None:
                conn.close()
                return
            chan = transport.open_channel(
                "direct-tcpip",
                ("127.0.0.1", self.remote_port),
                conn.getpeername(),
            )
        except Exception:  # noqa: BLE001
            conn.close()
            return

        try:
            while not self._stop.is_set():
                r, _, _ = select.select([conn, chan], [], [], 1.0)
                if conn in r:
                    data = conn.recv(4096)
                    if not data:
                        break
                    chan.sendall(data)
                if chan in r:
                    data = chan.recv(4096)
                    if not data:
                        break
                    conn.sendall(data)
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                chan.close()
            except Exception:  # noqa: BLE001
                pass
            conn.close()
