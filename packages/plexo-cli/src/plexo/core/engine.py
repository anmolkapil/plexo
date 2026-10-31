"""Parallel multi-adapter bonding download engine.

Distributes file chunks across verified network adapters concurrently,
tracks live per-adapter throughput, and writes to disk via sparse file mapping.
"""

from __future__ import annotations

import concurrent.futures
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional
from .adapter import NetworkAdapter, get_bonded_pool
from .client import BoundRangeClient, ProbeResult, probe_url, probe_mirrors
from .qos import QoSWatchdog
from .sparse import SparseFileWriter


@dataclass(order=True)
class DownloadChunk:
    priority: int
    chunk_id: int = field(compare=False)
    start_byte: int = field(compare=False)
    end_byte: int = field(compare=False)
    retries: int = field(default=0, compare=False)


@dataclass
class ProgressUpdate:
    total_bytes: int
    downloaded_bytes: int
    speed_bytes_sec: float
    adapter_speeds: dict[str, float]  # ip -> bytes/sec
    is_completed: bool = False
    filename: str = ""
    mirror_speeds: dict[str, float] = field(default_factory=dict)
    adapter_bytes: dict[str, int] = field(default_factory=dict)


class BondingDownloadEngine:
    """Orchestrates multi-adapter parallel downloads."""

    def __init__(
        self,
        url: str,
        output_path: Optional[str | Path] = None,
        adapters: Optional[List[NetworkAdapter]] = None,
        chunk_size: int = 8 * 1024 * 1024,  # 8 MB default chunk
        workers_per_adapter: int = 2,
        custom_headers: Optional[dict[str, str]] = None,
        cookie: Optional[str] = None,
        referer: Optional[str] = None,
        sequential: bool = False,
        quotas: Optional[dict[str, int]] = None,
        mirrors: Optional[List[str]] = None,
    ):
        self.url = url
        # Build normalized mirror list with primary URL leading
        all_mirrors = [url]
        if mirrors:
            for m in mirrors:
                m_str = str(m).strip()
                if m_str and m_str not in all_mirrors:
                    all_mirrors.append(m_str)
        self.mirrors: List[str] = all_mirrors
        self.mirror_bytes: dict[str, int] = {m: 0 for m in self.mirrors}
        self._mirror_failures: dict[str, int] = {m: 0 for m in self.mirrors}

        self.chunk_size = chunk_size
        self.workers_per_adapter = workers_per_adapter
        self.adapters = adapters or get_bonded_pool()
        self.output_path = output_path
        self.custom_headers = custom_headers or {}
        self.cookie = cookie
        self.referer = referer
        self.sequential = sequential
        self.quotas = quotas or {}

        self.probe: Optional[ProbeResult] = None
        self.watchdog = QoSWatchdog()
        for ident, q_bytes in self.quotas.items():
            self.watchdog.set_quota(ident, q_bytes)

        self._cancel_event = threading.Event()
        self._completed_bytes = 0
        self._bytes_lock = threading.Lock()
        self._start_time = 0.0

    def _prepare(self) -> ProbeResult:
        """Probes the remote server(s) and sets output path."""
        if self.probe is not None:
            return self.probe

        if len(self.mirrors) > 1:
            self.probe, verified = probe_mirrors(
                self.mirrors,
                custom_headers=self.custom_headers,
                cookie=self.cookie,
                referer=self.referer,
            )
            if verified:
                self.mirrors = verified
                for m in self.mirrors:
                    if m not in self.mirror_bytes:
                        self.mirror_bytes[m] = 0
                    if m not in self._mirror_failures:
                        self._mirror_failures[m] = 0
        else:
            self.probe = probe_url(
                self.url,
                custom_headers=self.custom_headers,
                cookie=self.cookie,
                referer=self.referer,
            )

        if not self.cookie and self.probe.session_cookies:
            self.cookie = self.probe.session_cookies
        if not self.referer and self.probe.referer:
            self.referer = self.probe.referer

        if not self.output_path:
            self.output_path = Path.cwd() / self.probe.filename
        else:
            self.output_path = Path(self.output_path)
            if self.output_path.is_dir() or str(self.output_path).endswith(("/", "\\")):
                self.output_path.mkdir(parents=True, exist_ok=True)
                self.output_path = self.output_path / self.probe.filename

        return self.probe

    def execute(
        self,
        progress_callback: Optional[Callable[[ProgressUpdate], None]] = None,
    ) -> Path:
        """Executes the bonded download and returns final output file path."""
        probe = self._prepare()
        target_path = Path(self.output_path)
        self._start_time = time.time()

        # If file doesn't support ranges or file size unknown, fall back to single-stream
        if not probe.accepts_ranges or probe.total_bytes <= 0:
            return self._execute_single_stream(probe, target_path, progress_callback)

        return self._execute_bonded_parallel(probe, target_path, progress_callback)

    def _execute_single_stream(
        self,
        probe: ProbeResult,
        target_path: Path,
        progress_callback: Optional[Callable[[ProgressUpdate], None]],
    ) -> Path:
        """Fallback for non-range servers with mirror failover."""
        adapter = self.adapters[0] if self.adapters else None
        local_ip = adapter.ip_address if adapter else "0.0.0.0"
        client = BoundRangeClient(
            local_ip=local_ip,
            custom_headers=self.custom_headers,
            cookie=self.cookie,
            referer=self.referer,
        )

        target_path.parent.mkdir(parents=True, exist_ok=True)
        downloaded = 0
        last_err: Optional[Exception] = None

        for candidate_url in self.mirrors:
            try:
                downloaded = 0
                with open(target_path, "wb") as f:
                    for chunk in client.fetch_range(candidate_url, 0, probe.total_bytes - 1 if probe.total_bytes > 0 else 0):
                        f.write(chunk)
                        downloaded += len(chunk)
                        with self._bytes_lock:
                            self.mirror_bytes[candidate_url] = self.mirror_bytes.get(candidate_url, 0) + len(chunk)
                        if progress_callback:
                            elapsed = max(0.001, time.time() - self._start_time)
                            m_speeds = {m: self.mirror_bytes.get(m, 0) / elapsed for m in self.mirrors}
                            progress_callback(
                                ProgressUpdate(
                                    total_bytes=probe.total_bytes or downloaded,
                                    downloaded_bytes=downloaded,
                                    speed_bytes_sec=downloaded / elapsed,
                                    adapter_speeds={local_ip: downloaded / elapsed},
                                    is_completed=False,
                                    filename=target_path.name,
                                    mirror_speeds=m_speeds,
                                    adapter_bytes={local_ip: downloaded},
                                )
                            )
                last_err = None
                break
            except Exception as e:
                last_err = e
                continue

        if last_err is not None:
            raise RuntimeError(f"All download mirrors failed in single-stream mode: {last_err}")

        if progress_callback:
            elapsed = max(0.001, time.time() - self._start_time)
            m_speeds = {m: self.mirror_bytes.get(m, 0) / elapsed for m in self.mirrors}
            progress_callback(
                ProgressUpdate(
                    total_bytes=downloaded,
                    downloaded_bytes=downloaded,
                    speed_bytes_sec=downloaded / elapsed,
                    adapter_speeds={local_ip: downloaded / elapsed},
                    is_completed=True,
                    filename=target_path.name,
                    mirror_speeds=m_speeds,
                    adapter_bytes={a.ip_address: (self.watchdog.get(a.ip_address).bytes_transferred if self.watchdog.get(a.ip_address) else 0) for a in self.adapters},
                )
            )

        return target_path

    def _execute_bonded_parallel(
        self,
        probe: ProbeResult,
        target_path: Path,
        progress_callback: Optional[Callable[[ProgressUpdate], None]],
    ) -> Path:
        """Executes multi-socket bonded chunk downloading with checkpoint resume."""
        import json
        total_bytes = probe.total_bytes
        chunk_queue: queue.PriorityQueue[DownloadChunk] = queue.PriorityQueue()
        state_file = target_path.with_name(target_path.name + ".plexo")
        completed_chunk_ids: set[int] = set()

        # Check for existing checkpoint
        if state_file.exists() and target_path.exists():
            try:
                with open(state_file, "r") as sf:
                    state_data = json.load(sf)
                    if state_data.get("total_bytes") == total_bytes:
                        completed_chunk_ids = set(state_data.get("completed_chunks", []))
            except Exception:
                completed_chunk_ids = set()

        # Build list of raw chunks
        raw_chunks = []
        offset = 0
        cid = 0
        while offset < total_bytes:
            end = min(offset + self.chunk_size - 1, total_bytes - 1)
            raw_chunks.append((cid, offset, end))
            offset = end + 1
            cid += 1

        total_chunks = len(raw_chunks)
        already_downloaded_bytes = 0

        # Prioritize chunks (Sequential mode: header [0], trailer [N-1], then 1..N-2)
        for chunk_id, start_b, end_b in raw_chunks:
            chunk_len = end_b - start_b + 1
            if chunk_id in completed_chunk_ids:
                already_downloaded_bytes += chunk_len
                continue

            if self.sequential:
                if chunk_id == 0:
                    priority = 0  # File header / moov container
                elif chunk_id == total_chunks - 1:
                    priority = 1  # File trailer / index
                else:
                    priority = chunk_id + 1  # Ascending sequential stream
            else:
                priority = chunk_id

            chunk_queue.put(
                DownloadChunk(
                    priority=priority,
                    chunk_id=chunk_id,
                    start_byte=start_b,
                    end_byte=end_b,
                )
            )

        self._completed_bytes = already_downloaded_bytes

        # Register adapters in QoS watchdog
        for a in self.adapters:
            self.watchdog.register(a.name, a.ip_address, a.kind)

        # Pre-allocate or open existing sparse file
        with SparseFileWriter(target_path, total_bytes) as writer:
            workers = []
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=len(self.adapters) * self.workers_per_adapter
            ) as executor:
                worker_counter = 0
                for adapter_idx, adapter in enumerate(self.adapters):
                    for _ in range(self.workers_per_adapter):
                        if len(self.mirrors) <= len(self.adapters):
                            preferred_mirror_idx = adapter_idx % len(self.mirrors)
                        else:
                            preferred_mirror_idx = worker_counter % len(self.mirrors)

                        future = executor.submit(
                            self._worker_loop,
                            adapter,
                            chunk_queue,
                            writer,
                            self.mirrors,
                            preferred_mirror_idx,
                            state_file,
                            completed_chunk_ids,
                            progress_callback,
                        )
                        workers.append(future)
                        worker_counter += 1

                # Wait for all workers or cancellation
                for future in concurrent.futures.as_completed(workers):
                    future.result()

        # Enforce that all chunks actually completed before reporting success
        if len(completed_chunk_ids) < total_chunks:
            raise RuntimeError(
                f"Download incomplete: {len(completed_chunk_ids)}/{total_chunks} chunks completed."
            )

        # Download completed successfully - clean up sidecar progress state
        if state_file.exists():
            try:
                state_file.unlink()
            except OSError:
                pass

        if progress_callback:
            elapsed = max(0.001, time.time() - self._start_time)
            m_speeds = {m: self.mirror_bytes.get(m, 0) / elapsed for m in self.mirrors}
            progress_callback(
                ProgressUpdate(
                    total_bytes=total_bytes,
                    downloaded_bytes=total_bytes,
                    speed_bytes_sec=total_bytes / elapsed,
                    adapter_speeds={a.ip_address: self.watchdog.get(a.ip_address).speed_bytes_per_sec for a in self.adapters},
                    is_completed=True,
                    filename=target_path.name,
                    mirror_speeds=m_speeds,
                    adapter_bytes={a.ip_address: (self.watchdog.get(a.ip_address).bytes_transferred if self.watchdog.get(a.ip_address) else 0) for a in self.adapters},
                )
            )

        return target_path

    def _select_mirror(self, preferred_idx: int, chunk_id: int, retries: int) -> str:
        """Selects a healthy mirror, cycling based on adapter/worker index, chunk ID, and retries."""
        with self._bytes_lock:
            healthy = [m for m in self.mirrors if self._mirror_failures.get(m, 0) < 2]
            if not healthy:
                healthy = self.mirrors

        num_healthy = len(healthy)
        num_adapters = max(1, len(self.adapters))
        if num_healthy <= num_adapters:
            # 1-to-1 adapter-to-mirror mapping (e.g. Adapter 1 -> Mirror 1, Adapter 2 -> Mirror 2)
            idx = (preferred_idx + retries) % num_healthy
        else:
            # More mirrors than adapters: cycle chunks across all healthy mirrors
            idx = (chunk_id + retries) % num_healthy
        return healthy[idx]

    def _worker_loop(
        self,
        adapter: NetworkAdapter,
        chunk_queue: queue.PriorityQueue[DownloadChunk],
        writer: SparseFileWriter,
        mirrors: List[str],
        preferred_mirror_idx: int,
        state_file: Path,
        completed_chunk_ids: set[int],
        progress_callback: Optional[Callable[[ProgressUpdate], None]],
    ) -> None:
        """Worker thread dedicated to a specific network adapter with mirror distribution."""
        client = BoundRangeClient(
            local_ip=adapter.ip_address,
            custom_headers=self.custom_headers,
            cookie=self.cookie,
            referer=self.referer,
        )
        metric = self.watchdog.get(adapter.ip_address)

        while not self._cancel_event.is_set():
            if not self.watchdog.can_accept_chunk(adapter.ip_address):
                # Hard quota exhausted for this connection - yield remaining work to other links
                break

            try:
                chunk = chunk_queue.get(timeout=0.2)
            except queue.Empty:
                with self._bytes_lock:
                    total_active = sum(m.active_chunks for m in self.watchdog.adapters.values())
                    if total_active == 0 and chunk_queue.empty():
                        break
                continue

            metric.active_chunks += 1
            chunk_data = bytearray()
            success = False

            # Select mirror URL: base offset from worker, rotating across healthy mirrors on retries
            target_url = self._select_mirror(preferred_mirror_idx, chunk.chunk_id, chunk.retries)

            try:
                def on_bytes(count: int):
                    metric.record_bytes(count)
                    with self._bytes_lock:
                        self._completed_bytes += count
                        self.mirror_bytes[target_url] = self.mirror_bytes.get(target_url, 0) + count
                    if progress_callback:
                        elapsed = max(0.001, time.time() - self._start_time)
                        speeds = {
                            a.ip_address: self.watchdog.get(a.ip_address).speed_bytes_per_sec
                            for a in self.adapters
                        }
                        m_speeds = {
                            m: self.mirror_bytes.get(m, 0) / elapsed
                            for m in self.mirrors
                        }
                        bytes_transferred = {
                            a.ip_address: self.watchdog.get(a.ip_address).bytes_transferred
                            for a in self.adapters
                        }
                        progress_callback(
                            ProgressUpdate(
                                total_bytes=self.probe.total_bytes,
                                downloaded_bytes=self._completed_bytes,
                                speed_bytes_sec=self._completed_bytes / elapsed,
                                adapter_speeds=speeds,
                                is_completed=False,
                                filename=self.output_path.name if self.output_path else "",
                                mirror_speeds=m_speeds,
                                adapter_bytes=bytes_transferred,
                            )
                        )

                for block in client.fetch_range(
                    target_url, chunk.start_byte, chunk.end_byte, on_bytes=on_bytes
                ):
                    chunk_data.extend(block)

                # Write directly into sparse file offset
                writer.write_chunk(chunk.start_byte, bytes(chunk_data))
                with self._bytes_lock:
                    self._mirror_failures[target_url] = 0
                    completed_chunk_ids.add(chunk.chunk_id)
                    try:
                        import json
                        with open(state_file, "w") as sf:
                            json.dump(
                                {
                                    "total_bytes": self.probe.total_bytes,
                                    "completed_chunks": sorted(list(completed_chunk_ids)),
                                },
                                sf,
                            )
                    except Exception:
                        pass
                success = True

            except Exception as err:
                with self._bytes_lock:
                    self._mirror_failures[target_url] = self._mirror_failures.get(target_url, 0) + 1
                    if len(chunk_data) > 0:
                        self._completed_bytes -= len(chunk_data)
                        self.mirror_bytes[target_url] = max(0, self.mirror_bytes.get(target_url, 0) - len(chunk_data))
                chunk.retries += 1
                if chunk.retries >= len(self.mirrors):
                    metric.record_error()
                max_retries = max(5, len(self.mirrors) * 2)
                if chunk.retries < max_retries:
                    # Re-queue for another mirror / adapter attempt
                    chunk_queue.put(chunk)
                else:
                    self._cancel_event.set()
                    raise RuntimeError(f"Chunk {chunk.chunk_id} failed permanently across mirrors: {err}")

            finally:
                metric.active_chunks -= 1
                chunk_queue.task_done()
