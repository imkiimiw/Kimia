"""SSRF guard: every outbound URL (and every redirect hop) must point at a public address."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Iterable
from typing import Protocol
from urllib.parse import urlsplit


class Resolver(Protocol):
    async def resolve(self, host: str, port: int) -> list[str]: ...


class SystemResolver:
    async def resolve(self, host: str, port: int) -> list[str]:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        return sorted({str(info[4][0]) for info in infos})


class StaticResolver:
    """For tests: a fixed host → addresses map (no network)."""

    def __init__(self, table: dict[str, list[str]], default: list[str] | None = None) -> None:
        self._table = table
        self._default = default

    async def resolve(self, host: str, port: int) -> list[str]:
        if host in self._table:
            return self._table[host]
        if self._default is not None:
            return self._default
        raise OSError(f"cannot resolve {host}")


class SsrfBlocked(Exception):
    pass


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


class UrlGuard:
    def __init__(self, resolver: Resolver, allowed_ports: Iterable[int]) -> None:
        self._resolver = resolver
        self._ports = frozenset(allowed_ports)

    async def check(self, url: str) -> None:
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError as exc:
            raise SsrfBlocked(f"malformed url: {exc}") from exc
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https"):
            raise SsrfBlocked(f"scheme not allowed: {scheme or '-'}")
        if parts.username or parts.password:
            raise SsrfBlocked("credentials in url")
        host = parts.hostname
        if not host:
            raise SsrfBlocked("no host")
        port = port or (443 if scheme == "https" else 80)
        if port not in self._ports:
            raise SsrfBlocked(f"port not allowed: {port}")
        if host in ("localhost",) or host.endswith((".localhost", ".local", ".internal")):
            raise SsrfBlocked(f"internal host: {host}")
        try:
            ipaddress.ip_address(host)
            addresses = [host]
        except ValueError:
            try:
                addresses = await self._resolver.resolve(host, port)
            except OSError as exc:
                raise SsrfBlocked(f"cannot resolve {host}: {exc}") from exc
        if not addresses:
            raise SsrfBlocked(f"no address for {host}")
        bad = [a for a in addresses if not is_public_address(a)]
        if bad:
            raise SsrfBlocked(f"{host} resolves to a non-public address")
