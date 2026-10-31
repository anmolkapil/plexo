"""Bonded video transport and orchestration engine.

Integrates stream resolution with multi-adapter chunked downloading,
automatic track retrieval (video + audio + subtitles), and zero-copy container muxing.
"""

from __future__ import annotations

import os
import re
import urllib3
from pathlib import Path
from typing import Callable, List, Optional

from ..core.adapter import NetworkAdapter, get_bonded_pool
from ..core.client import DEFAULT_USER_AGENT, parse_cookie_input
from ..core.engine import BondingDownloadEngine, ProgressUpdate
from .muxer import is_ffmpeg_available, mux_media_streams
from .resolver import VideoMetadata, SubtitleTrack


def sanitize_filename(name: str, max_length: int = 120) -> str:
    """Strips illegal filesystem characters and limits filename length safely."""
    # Remove characters forbidden on Windows/Linux/macOS
    clean = re.sub(r'[\\/*?:"<>|]', "", name)
    # Collapse consecutive whitespace
    clean = re.sub(r"\s+", " ", clean).strip()
    # Remove leading/trailing dots or spaces
    clean = clean.strip(". ")
    if not clean:
        clean = "plexo_download"
    if len(clean) > max_length:
        clean = clean[:max_length].rstrip(". ")
    return clean


def download_subtitle_track(
    sub: SubtitleTrack,
    target_path: Path,
    cookie: Optional[str] = None,
    referer: Optional[str] = None,
) -> Path:
    """Downloads a subtitle track via lightweight HTTP GET."""
    target_path = Path(target_path).resolve()
    target_path.parent.mkdir(parents=True, exist_ok=True)

    http = urllib3.PoolManager()
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
    }
    if cookie:
        headers["Cookie"] = parse_cookie_input(cookie)
    if referer:
        headers["Referer"] = referer

    resp = http.request("GET", sub.url, headers=headers, timeout=15.0)
    if resp.status < 400:
        with open(target_path, "wb") as f:
            f.write(resp.data)
    return target_path


class BondedVideoDownloader:
    """Coordinates bonded multi-adapter downloading of video, audio, and subtitle streams."""

    def __init__(
        self,
        metadata: VideoMetadata,
        output_path: Optional[str | Path] = None,
        adapters: Optional[List[NetworkAdapter]] = None,
        chunk_size: int = 8 * 1024 * 1024,
        workers_per_adapter: int = 2,
        sequential: bool = False,
        quotas: Optional[dict[str, int]] = None,
        custom_headers: Optional[dict[str, str]] = None,
        cookie: Optional[str] = None,
        referer: Optional[str] = None,
    ):
        self.metadata = metadata
        self.output_path_spec = output_path
        self.adapters = adapters or get_bonded_pool()
        self.chunk_size = chunk_size
        self.workers_per_adapter = workers_per_adapter
        self.sequential = sequential
        self.quotas = quotas or {}
        self.custom_headers = custom_headers or {}
        self.cookie = cookie
        self.referer = referer or metadata.webpage_url

    def resolve_target_destination(self) -> Path:
        """Computes the primary output destination path based on metadata and user spec."""
        title = sanitize_filename(self.metadata.title)

        # Determine target extension
        if not self.metadata.selected_video:
            # Audio-only mode
            ext = f".{self.metadata.selected_audio.ext}" if self.metadata.selected_audio else ".m4a"
        else:
            v_ext = (self.metadata.selected_video.ext or "").lower()
            a_ext = (self.metadata.selected_audio.ext if self.metadata.selected_audio else "").lower()
            if v_ext in ("webm", "mkv") or a_ext in ("opus", "webm"):
                ext = ".mkv"
            else:
                ext = ".mp4"

        if not self.output_path_spec:
            return Path.cwd() / f"{title}{ext}"

        spec_path = Path(self.output_path_spec)
        # If spec points to an existing directory or ends with a slash/separator
        if spec_path.is_dir() or str(self.output_path_spec).endswith(("/", "\\")):
            return spec_path / f"{title}{ext}"

        # If user explicitly supplied a filename extension (e.g. out.mp4)
        if spec_path.suffix:
            return spec_path

        # If spec is a file stem without extension
        return spec_path.with_suffix(ext)

    def download(
        self,
        progress_callback: Optional[Callable[[ProgressUpdate], None]] = None,
        stage_callback: Optional[Callable[[str, int], None]] = None,
    ) -> Path:
        """Downloads all requisite tracks across bonded adapters and muxes if necessary.
        
        Args:
            progress_callback: Called on chunk transfer progress.
            stage_callback: Called when switching stages (e.g., stage_callback("Video Track", total_bytes)).
        
        Returns:
            Final Path of the completed media file.
        """
        dest_path = self.resolve_target_destination()
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        stem = dest_path.stem
        parent = dest_path.parent

        video_track = self.metadata.selected_video
        audio_track = self.metadata.selected_audio
        sub_tracks = self.metadata.selected_subtitles

        # Case 1: Audio Only
        if not video_track:
            if not audio_track:
                raise ValueError("No playable video or audio streams found for this URL.")
            if stage_callback:
                stage_callback(f"{stem} [Audio]", audio_track.filesize)
            engine = BondingDownloadEngine(
                url=audio_track.url,
                output_path=dest_path,
                adapters=self.adapters,
                chunk_size=self.chunk_size,
                workers_per_adapter=self.workers_per_adapter,
                custom_headers=self.custom_headers,
                cookie=self.cookie,
                referer=self.referer,
                sequential=self.sequential,
                quotas=self.quotas,
            )
            return engine.execute(progress_callback=progress_callback)

        # Case 2: Single combined video+audio stream (no muxing required)
        if video_track.has_audio or not audio_track:
            if stage_callback:
                stage_callback(f"{stem} [{video_track.resolution}]", video_track.filesize)
            engine = BondingDownloadEngine(
                url=video_track.url,
                output_path=dest_path,
                adapters=self.adapters,
                chunk_size=self.chunk_size,
                workers_per_adapter=self.workers_per_adapter,
                custom_headers=self.custom_headers,
                cookie=self.cookie,
                referer=self.referer,
                sequential=self.sequential,
                quotas=self.quotas,
            )
            final_video = engine.execute(progress_callback=progress_callback)

            # Download any requested subtitles alongside
            for sub in sub_tracks:
                sub_path = parent / f"{stem}.{sub.language}.{sub.ext}"
                download_subtitle_track(sub, sub_path, cookie=self.cookie, referer=self.referer)

            return final_video

        # Case 3: Split Video and Audio streams (requires zero-copy muxing)
        v_ext = video_track.ext or "mp4"
        a_ext = audio_track.ext or "m4a"
        temp_video_path = parent / f".tmp_{stem}_video.{v_ext}"
        temp_audio_path = parent / f".tmp_{stem}_audio.{a_ext}"

        # Step 3a: Download Video Stream
        if stage_callback:
            stage_callback(f"{stem} [{video_track.resolution} Video]", video_track.filesize)
        video_engine = BondingDownloadEngine(
            url=video_track.url,
            output_path=temp_video_path,
            adapters=self.adapters,
            chunk_size=self.chunk_size,
            workers_per_adapter=self.workers_per_adapter,
            custom_headers=self.custom_headers,
            cookie=self.cookie,
            referer=self.referer,
            sequential=self.sequential,
            quotas=self.quotas,
        )
        downloaded_video = video_engine.execute(progress_callback=progress_callback)

        # Step 3b: Download Audio Stream
        if stage_callback:
            stage_callback(f"{stem} [Audio {audio_track.abr:.0f}k]", audio_track.filesize)
        audio_engine = BondingDownloadEngine(
            url=audio_track.url,
            output_path=temp_audio_path,
            adapters=self.adapters,
            chunk_size=self.chunk_size,
            workers_per_adapter=self.workers_per_adapter,
            custom_headers=self.custom_headers,
            cookie=self.cookie,
            referer=self.referer,
            sequential=self.sequential,
            quotas=self.quotas,
        )
        downloaded_audio = audio_engine.execute(progress_callback=progress_callback)

        # Step 3c: Download Subtitles
        downloaded_subs: List[Path] = []
        for sub in sub_tracks:
            sub_path = parent / f"{stem}.{sub.language}.{sub.ext}"
            download_subtitle_track(sub, sub_path, cookie=self.cookie, referer=self.referer)
            downloaded_subs.append(sub_path)

        # Step 3d: Zero-Copy Muxing
        if stage_callback:
            stage_callback("Muxing media streams...", 0)

        if is_ffmpeg_available():
            muxed_result = mux_media_streams(
                video_path=downloaded_video,
                audio_path=downloaded_audio,
                subtitle_paths=downloaded_subs if dest_path.suffix.lower() == ".mkv" else None,
                output_path=dest_path,
            )
            # If muxing succeeded and produced the expected dest_path
            if muxed_result.exists() and muxed_result == dest_path:
                try:
                    if downloaded_video.exists():
                        downloaded_video.unlink()
                    if downloaded_audio.exists():
                        downloaded_audio.unlink()
                except OSError:
                    pass
                return dest_path

        # Fallback if ffmpeg is missing or muxing failed: preserve both files cleanly
        fallback_video = parent / f"{stem}_video.{v_ext}"
        fallback_audio = parent / f"{stem}_audio.{a_ext}"
        if downloaded_video.exists() and downloaded_video != fallback_video:
            try:
                downloaded_video.replace(fallback_video)
            except OSError:
                fallback_video = downloaded_video

        if downloaded_audio.exists() and downloaded_audio != fallback_audio:
            try:
                downloaded_audio.replace(fallback_audio)
            except OSError:
                fallback_audio = downloaded_audio

        return fallback_video
