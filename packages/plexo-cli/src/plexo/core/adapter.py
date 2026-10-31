"""Network interface discovery and binding module.

Detects active network adapters (Wi-Fi, USB cellular tether, Ethernet),
filters internal/virtual networks, and verifies outward internet reachability.
"""

from __future__ import annotations

import ipaddress
import platform
import socket
import struct
import subprocess
from dataclasses import dataclass
from typing import List, Optional
import psutil
import urllib3

SO_BINDTODEVICE = 25
IP_BOUND_IF = 25
IPV6_BOUND_IF = 125


def bind_socket_to_interface(sock: socket.socket, iface_name: str, iface_ip: Optional[str] = None) -> None:
    """
    Bind a socket to a specific network interface across Linux, macOS, and Windows.
    Prevents Linux Weak Host kernel routing from funnelling packets into default gateway.
    """
    current_os = platform.system().lower()
    if current_os == "linux":
        try:
            sock.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, iface_name.encode("utf-8") + b"\0")
        except (PermissionError, OSError):
            if iface_ip:
                sock.bind((iface_ip, 0))
    elif current_os == "darwin":
        try:
            if_index = socket.if_nametoindex(iface_name)
            opt = IP_BOUND_IF if sock.family == socket.AF_INET else IPV6_BOUND_IF
            sock.setsockopt(socket.IPPROTO_IP if sock.family == socket.AF_INET else socket.IPPROTO_IPV6, opt, struct.pack("I", if_index))
        except Exception:
            if iface_ip:
                sock.bind((iface_ip, 0))
    else:
        if iface_ip:
            sock.bind((iface_ip, 0))


@dataclass
class NetworkAdapter:
    """Represents a discovered physical or virtual network interface."""
    name: str
    ip_address: str
    netmask: str
    kind: str  # "wifi", "usb", "ethernet", "other"
    is_up: bool
    speed_mbps: int = 0
    gateway: Optional[str] = None
    is_online: bool = False

    @property
    def display_name(self) -> str:
        kind_label = self.kind.upper()
        return f"{self.name} [{kind_label}] ({self.ip_address})"


def classify_interface(name: str) -> str:
    """Classifies interface type based on OS naming conventions."""
    name_lower = name.lower()
    if any(k in name_lower for k in ("wi-fi", "wifi", "wireless", "wlan", "802.11")):
        return "wifi"
    if any(k in name_lower for k in ("rndis", "tether", "remote ndis", "apple mobile", "usb", "enx")):
        return "usb"
    if any(k in name_lower for k in ("ethernet", "lan", "eth", "en0", "en1")):
        return "ethernet"
    return "other"


def is_usable_ip(ip_str: str) -> bool:
    """Checks if an IPv4 address is routable and not loopback/link-local."""
    try:
        ip = ipaddress.IPv4Address(ip_str)
        if ip.is_loopback:
            return False
        if ip.is_link_local:  # 169.254.x.x
            return False
        if ip.is_unspecified:  # 0.0.0.0
            return False
        return True
    except (ValueError, ipaddress.AddressValueError):
        return False


def test_adapter_connectivity(ip_address: str, iface_name: Optional[str] = None, timeout: float = 2.0) -> bool:
    """Verifies that an outgoing connection bound to this source IP can reach the internet."""
    test_hosts = [("1.1.1.1", 53), ("8.8.8.8", 53)]
    for host, port in test_hosts:
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            if iface_name:
                bind_socket_to_interface(sock, iface_name, ip_address)
            else:
                sock.bind((ip_address, 0))
            sock.connect((host, port))
            return True
        except (socket.error, OSError):
            continue
        finally:
            if sock:
                sock.close()
    return False


def discover_adapters(verify_online: bool = True) -> List[NetworkAdapter]:
    """Discovers all active, routable network adapters."""
    adapters: List[NetworkAdapter] = []
    seen_ips = set()

    if_addrs = psutil.net_if_addrs()
    if_stats = psutil.net_if_stats()

    # Exclude common internal virtual switches unless they provide genuine routes
    virtual_keywords = ("vEthernet", "Hyper-V", "VirtualBox", "VMware", "Loopback", "WSL")

    for iface_name, addrs in if_addrs.items():
        if any(v.lower() in iface_name.lower() for v in virtual_keywords):
            continue

        stats = if_stats.get(iface_name)
        is_up = stats.isup if stats else True
        if not is_up:
            continue

        for addr in addrs:
            # We focus on IPv4 for multi-adapter bonding
            if addr.family == socket.AF_INET:
                ip = addr.address
                if ip in seen_ips or not is_usable_ip(ip):
                    continue

                seen_ips.add(ip)
                kind = classify_interface(iface_name)
                speed = stats.speed if stats else 0

                online = False
                if verify_online:
                    online = test_adapter_connectivity(ip, iface_name=iface_name)

                adapter = NetworkAdapter(
                    name=iface_name,
                    ip_address=ip,
                    netmask=addr.netmask or "255.255.255.0",
                    kind=kind,
                    is_up=is_up,
                    speed_mbps=speed,
                    is_online=online if verify_online else is_up,
                )
                adapters.append(adapter)

    # Sort so online adapters appear first, prioritized by speed/type
    adapters.sort(key=lambda a: (not a.is_online, a.kind == "other", a.name))
    return adapters


def get_bonded_pool(min_adapters: int = 1) -> List[NetworkAdapter]:
    """Returns all verified online adapters ready for bonding."""
    adapters = discover_adapters(verify_online=True)
    online = [a for a in adapters if a.is_online]
    return online if online else adapters
