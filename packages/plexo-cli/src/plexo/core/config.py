"""User configuration and compliance notice manager."""

from __future__ import annotations

import json
from pathlib import Path
from rich.console import Console
from rich.panel import Panel

console = Console()
CONFIG_DIR = Path.home() / ".plexo"
CONFIG_FILE = CONFIG_DIR / "config.json"


def show_first_time_notice_if_needed() -> None:
    """
    Display a one-time educational & compliance disclaimer on first run of `plexo video`.
    Ensures clear boundaries regarding copyright and DRM circumvention.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if data.get("disclaimer_accepted"):
                return
        except Exception:
            pass

    notice = (
        "[bold cyan]Plexo Video Optimization Engine[/bold cyan]\n\n"
        "[white]• Plexo is designed for multi-network bandwidth aggregation and stream analysis.[/white]\n"
        "[white]• Plexo strictly does [bold red]NOT[/bold red] bypass digital rights management (DRM) or paywalls.[/white]\n"
        "[white]• Users are responsible for complying with content providers' Terms of Service and applicable copyright laws.[/white]"
    )
    console.print(Panel(notice, title="[yellow]Fair Use & Compliance Notice[/yellow]", border_style="yellow"))

    try:
        CONFIG_FILE.write_text(json.dumps({"disclaimer_accepted": True}, indent=2), encoding="utf-8")
    except Exception:
        pass
