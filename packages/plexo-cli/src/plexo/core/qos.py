"""QoS watchdog, adapter health monitoring, and data quota controls.

Tracks real-time throughput, enforces per-connection data ceilings,
and triggers failover when hotspots stall or quotas exhaust.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, Optional


def parse_size_str(val: str) -> int:
    """Parses human-readable size strings (e.g. '1.5GB', '500MB', '256KB') into bytes."""
    val = val.strip().upper()
    if val.endswith("GB") or val.endswith("G"):
        num = float(val.rstrip("GB"))
        return int(num * 1024 * 1024 * 1024)
    if val.endswith("MB") or val.endswith("M"):
        num = float(val.rstrip("MB"))
        return int(num * 1024 * 1024)
    if val.endswith("KB") or val.endswith("K"):
        num = float(val.rstrip("KB"))
        return int(num * 1024)
    return int(val)


@dataclass
class AdapterMetrics:
    """Live performance metrics for a specific adapter."""
    name: str
    ip_address: str
    kind: str
    bytes_transferred: int = 0
    active_chunks: int = 0
    last_byte_time: float = field(default_factory=time.time)
    start_time: float = field(default_factory=time.time)
    errors: int = 0
    is_healthy: bool = True
    quota_bytes: Optional[int] = None
    is_exhausted: bool = False

    def record_bytes(self, count: int) -> None:
        self.bytes_transferred += count
        self.last_byte_time = time.time()
        if self.quota_bytes is not None and self.bytes_transferred >= self.quota_bytes:
            self.is_exhausted = True
            self.is_healthy = False

    def record_error(self) -> None:
        self.errors += 1
        if self.errors > 3:
            self.is_healthy = False

    @property
    def speed_bytes_per_sec(self) -> float:
        elapsed = time.time() - self.start_time
        if elapsed <= 0:
            return 0.0
        return self.bytes_transferred / elapsed

    @property
    def speed_mbps(self) -> float:
        return (self.speed_bytes_per_sec * 8) / (1024 * 1024)

    @property
    def is_stalled(self) -> bool:
        """Returns true if active chunks exist but no data received for > 8 seconds."""
        if self.active_chunks > 0 and (time.time() - self.last_byte_time > 8.0):
            return True
        return False


class QoSWatchdog:
    """Coordinates multi-adapter health, data quotas, and failure detection."""

    def __init__(self):
        self.adapters: Dict[str, AdapterMetrics] = {}
        self.pending_quotas: Dict[str, int] = {}

    def register(self, name: str, ip_address: str, kind: str) -> AdapterMetrics:
        metric = AdapterMetrics(name=name, ip_address=ip_address, kind=kind)
        # Apply pending quotas matching name, kind, or ip
        for pattern, max_b in self.pending_quotas.items():
            p_lower = pattern.lower()
            if p_lower in name.lower() or p_lower == kind.lower() or p_lower == ip_address:
                metric.quota_bytes = max_b
                break

        self.adapters[ip_address] = metric
        return metric

    def set_quota(self, identifier: str, max_bytes: int) -> None:
        """Sets hard byte ceiling for an adapter matching name, kind (usb, wifi), or IP."""
        self.pending_quotas[identifier] = max_bytes
        ident_lower = identifier.lower()
        for ip, metric in self.adapters.items():
            if (
                ident_lower in metric.name.lower()
                or ident_lower == metric.kind.lower()
                or ident_lower == ip
            ):
                metric.quota_bytes = max_bytes

    def can_accept_chunk(self, ip_address: str) -> bool:
        """Returns True if the adapter has quota remaining and is healthy."""
        metric = self.adapters.get(ip_address)
        if not metric:
            return True
        if metric.is_exhausted or (metric.quota_bytes and metric.bytes_transferred >= metric.quota_bytes):
            return False
        return metric.is_healthy

    def get(self, ip_address: str) -> AdapterMetrics:
        return self.adapters[ip_address]

    def check_health(self) -> Dict[str, bool]:
        """Audits all adapters and returns active health status."""
        status = {}
        for ip, metric in self.adapters.items():
            if metric.is_stalled or metric.is_exhausted:
                metric.is_healthy = False
            status[ip] = metric.is_healthy
        return status
