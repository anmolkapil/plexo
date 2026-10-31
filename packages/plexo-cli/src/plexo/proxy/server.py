"""Local HTTP/HTTPS forward proxy for accelerating terminal tools (pip, git, curl).

Routes requests through the multi-adapter bonding engine or tunnels HTTPS.
Enforces loopback restriction, timing-safe authentication, and CONNECT port filtering.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import re
import socket
from typing import Optional, Set, Tuple
from rich.console import Console
from ..core.adapter import get_bonded_pool

ALLOWED_CONNECT_PORTS: Set[int] = {80, 443}


def is_loopback_host(host: str) -> bool:
    """Check if the given host resolves strictly to a loopback interface."""
    if host.lower() in ("localhost", "ip6-localhost", "ip6-loopback"):
        return True
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
        return ip.is_loopback
    except ValueError:
        return False


def validate_proxy_auth(auth_header: Optional[str], expected_credentials: str) -> bool:
    """
    Validate Proxy-Authorization Basic credentials using constant-time comparison.
    expected_credentials must be formatted as 'username:password'.
    """
    if not auth_header or not expected_credentials:
        return False

    parts = auth_header.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return False

    try:
        decoded = base64.b64decode(parts[1]).decode("utf-8")
        return hmac.compare_digest(decoded, expected_credentials)
    except Exception:
        return False


class LocalBondedProxy:
    """Asynchronous local HTTP/HTTPS accelerator proxy with security guardrails."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8899,
        auth: Optional[str] = None,
        allow_remote: bool = False,
        console: Optional[Console] = None,
    ):
        if not is_loopback_host(host) and not auth and not allow_remote:
            raise ValueError(
                f"Refusing to bind to non-loopback host '{host}' without authentication.\n"
                "To bind to remote interfaces, provide --auth user:pass or explicitly pass --allow-remote."
            )

        self.host = host
        self.port = port
        self.auth = auth
        self.allow_remote = allow_remote
        self.console = console or Console()
        self.server: Optional[asyncio.Server] = None
        self._adapters = []

    async def start(self) -> None:
        """Starts the local proxy server."""
        self._adapters = get_bonded_pool()
        self.server = await asyncio.start_server(
            self._handle_client, self.host, self.port
        )
        self.console.print(
            f"[bold green]Plexo Proxy running on {self.host}:{self.port}[/bold green]"
        )
        if self.auth:
            self.console.print("[yellow]Proxy Authentication: ENABLED (Basic)[/yellow]")
        self.console.print(
            f"[cyan]Bonding across {len(self._adapters)} network interfaces:[/cyan]"
        )
        for a in self._adapters:
            self.console.print(f"  * {a.name} ({a.ip_address})")

        auth_str = f"{self.auth}@" if self.auth else ""
        self.console.print(
            "\n[dim]To use with pip:[/dim]\n"
            f"  pip install <package> --proxy http://{auth_str}{self.host}:{self.port}\n\n"
            "[dim]To use globally in terminal:[/dim]\n"
            f"  $env:HTTPS_PROXY = \"http://{auth_str}{self.host}:{self.port}\"\n"
        )

        async with self.server:
            await self.server.serve_forever()

    async def _handle_client(
        self, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
    ) -> None:
        """Handles client connection with auth verification and port filtering."""
        try:
            request_line = await client_reader.readline()
            if not request_line:
                client_writer.close()
                return

            words = request_line.decode("latin1").split()
            if len(words) < 2:
                client_writer.close()
                return

            method, url = words[0], words[1]

            # Read headers
            raw_headers = bytearray()
            headers_dict = {}
            while True:
                line = await client_reader.readline()
                if not line or line == b"\r\n":
                    break
                raw_headers.extend(line)
                decoded_line = line.decode("latin1").strip()
                if ":" in decoded_line:
                    k, v = decoded_line.split(":", 1)
                    headers_dict[k.strip().lower()] = v.strip()

            # 1. Enforce Authentication Check
            if self.auth:
                auth_val = headers_dict.get("proxy-authorization")
                if not validate_proxy_auth(auth_val, self.auth):
                    client_writer.write(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                        b'Proxy-Authenticate: Basic realm="Plexo Proxy"\r\n'
                        b"Connection: close\r\n"
                        b"Content-Length: 0\r\n\r\n"
                    )
                    await client_writer.drain()
                    client_writer.close()
                    return

            # 2. Enforce CONNECT Port Restriction
            if method.upper() == "CONNECT":
                host, port_str = url.split(":") if ":" in url else (url, "443")
                try:
                    port = int(port_str)
                except ValueError:
                    port = 443

                if port not in ALLOWED_CONNECT_PORTS:
                    msg = (
                        "HTTP/1.1 403 Forbidden\r\n"
                        "Content-Type: text/plain\r\n"
                        "Connection: close\r\n\r\n"
                        f"CONNECT to port {port} is restricted by Plexo.\r\n"
                    ).encode("utf-8")
                    client_writer.write(msg)
                    await client_writer.drain()
                    client_writer.close()
                    return

                # HTTPS Tunneling
                await self._handle_connect(host, port, client_reader, client_writer)
            else:
                # Plain HTTP proxy
                await self._handle_http(method, url, request_line + raw_headers + b"\r\n", client_reader, client_writer)

        except Exception:
            try:
                client_writer.close()
            except Exception:
                pass

    async def _handle_connect(
        self, host: str, port: int, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
    ) -> None:
        """Tunnels HTTPS connections directly."""
        try:
            adapter = self._adapters[0] if self._adapters else None
            local_addr = (adapter.ip_address, 0) if adapter else None

            remote_reader, remote_writer = await asyncio.open_connection(
                host, port, local_addr=local_addr
            )

            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client_writer.drain()

            await asyncio.gather(
                self._pipe(client_reader, remote_writer),
                self._pipe(remote_reader, client_writer),
                return_exceptions=True,
            )
        except Exception:
            try:
                client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await client_writer.drain()
                client_writer.close()
            except Exception:
                pass

    async def _handle_http(
        self,
        method: str,
        url: str,
        full_request: bytes,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
    ) -> None:
        """Forwards standard HTTP requests."""
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or "localhost"
        port = parsed.port or 80

        try:
            remote_reader, remote_writer = await asyncio.open_connection(host, port)
            remote_writer.write(full_request)
            await remote_writer.drain()

            await asyncio.gather(
                self._pipe(client_reader, remote_writer),
                self._pipe(remote_reader, client_writer),
                return_exceptions=True,
            )
        except Exception:
            try:
                client_writer.close()
            except Exception:
                pass

    async def _pipe(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Pipes bytes between reader and writer until EOF."""
        try:
            while not reader.at_eof():
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass


def run_proxy(
    host: str = "127.0.0.1",
    port: int = 8899,
    auth: Optional[str] = None,
    allow_remote: bool = False,
) -> None:
    """Synchronous launcher for the proxy server."""
    proxy = LocalBondedProxy(host=host, port=port, auth=auth, allow_remote=allow_remote)
    asyncio.run(proxy.start())
