"""Diagnostic engine for validating multi-network interface routing and throughput deltas."""

from __future__ import annotations

import time
from typing import List, Tuple
import psutil
from rich.console import Console
from rich.table import Table

console = Console()


def run_doctor_diagnostic(active_interfaces: List[str], duration_secs: float = 2.0) -> bool:
    """
    Measures per-NIC throughput deltas.
    Warns if bonding is configured but only one link carries all traffic.
    """
    console.print("\n[bold cyan]🔍 Running Plexo Doctor Diagnostic...[/bold cyan]")
    console.print(f"Sampling interface traffic for {duration_secs}s...\n")

    before = {
        nic: (stat.bytes_sent, stat.bytes_recv)
        for nic, stat in psutil.net_io_counters(pernic=True).items()
    }
    time.sleep(duration_secs)
    after = {
        nic: (stat.bytes_sent, stat.bytes_recv)
        for nic, stat in psutil.net_io_counters(pernic=True).items()
    }

    table = Table(title="Interface Activity Test")
    table.add_column("Interface", style="cyan")
    table.add_column("Recv Delta", justify="right", style="green")
    table.add_column("Sent Delta", justify="right", style="yellow")
    table.add_column("Status", style="magenta")

    active_count = 0
    for nic in active_interfaces:
        b_sent, b_recv = before.get(nic, (0, 0))
        a_sent, a_recv = after.get(nic, (0, 0))

        d_recv = a_recv - b_recv
        d_sent = a_sent - b_sent

        if d_recv > 512 or d_sent > 512:
            status = "✅ ACTIVE"
            active_count += 1
        else:
            status = "⚠️ IDLE / NO TRAFFIC"

        table.add_row(
            nic,
            f"{d_recv / 1024:.1f} KB",
            f"{d_sent / 1024:.1f} KB",
            status,
        )

    console.print(table)

    if len(active_interfaces) > 1 and active_count <= 1:
        console.print(
            "\n[bold yellow]⚠️ WARNING: Only 1 interface carried traffic during multi-link test![/bold yellow]\n"
            "[white]On Linux: Kernel Weak Host routing may be forcing traffic through default gateway.[/white]\n"
            "[white]Fix: Run with 'sudo' (for SO_BINDTODEVICE) or configure policy routing tables.[/white]\n"
        )
        return False

    console.print("\n[bold green]✅ Health Check Complete.[/bold green]\n")
    return True
