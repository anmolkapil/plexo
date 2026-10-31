"""Universal media stream resolver and lexicographical quality fallback engine.

Extracts direct audio, video, and subtitle stream URLs across 1,800+ platforms using
yt-dlp in metadata-only mode without downloading bytes.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


def check_video_dependencies() -> None:
    """Ensure optional [video] dependencies are installed before executing."""
    missing = []
    try:
        import yt_dlp
    except ImportError:
        missing.append("yt-dlp")

    try:
        import curl_cffi
    except ImportError:
        missing.append("curl_cffi")

    if missing:
        sys.stderr.write(
            "\nError: Missing optional video dependencies!\n"
            f"The following packages are required for 'plexo video': {', '.join(missing)}\n\n"
            "To install them, run:\n"
            "    pip install 'plexo-cli[video]'\n\n"
        )
        sys.exit(1)


def get_ffmpeg_binary() -> Optional[str]:
    """
    Prefer system ffmpeg on PATH.
    Fallback to imageio-ffmpeg only if system ffmpeg is absent.
    """
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


@dataclass
class VideoTrack:
    """Represents an extracted video stream variant."""
    format_id: str
    ext: str
    resolution: str
    height: int
    width: int
    fps: int
    vcodec: str
    url: str
    filesize: int = 0
    tbr: float = 0.0
    has_audio: bool = False


@dataclass
class AudioTrack:
    """Represents an extracted audio stream variant."""
    format_id: str
    ext: str
    language: str
    abr: float  # Audio bitrate in kbps
    acodec: str
    url: str
    filesize: int = 0


@dataclass
class SubtitleTrack:
    """Represents an extracted subtitle or closed-caption track."""
    language: str
    name: str
    url: str
    ext: str = "vtt"
    is_auto_generated: bool = False


@dataclass
class VideoMetadata:
    """Complete resolved media manifest containing selected tracks and full variants."""
    title: str
    id: str
    webpage_url: str
    duration: int
    uploader: str
    thumbnail: str = ""
    selected_video: Optional[VideoTrack] = None
    selected_audio: Optional[AudioTrack] = None
    selected_subtitles: List[SubtitleTrack] = field(default_factory=list)
    all_videos: List[VideoTrack] = field(default_factory=list)
    all_audios: List[AudioTrack] = field(default_factory=list)
    all_subtitles: List[SubtitleTrack] = field(default_factory=list)


def parse_target_resolution(quality_str: str | int) -> int:
    """Normalizes quality input strings into vertical pixel heights.
    
    Examples:
        '1080p' -> 1080
        '1080'  -> 1080
        '720'   -> 720
        '4k'    -> 2160
        '2k'    -> 1440
        'best'  -> 999999
        'worst' -> 1
    """
    if isinstance(quality_str, int):
        return quality_str

    q = str(quality_str).strip().lower()
    if q in ("best", "max", "highest", ""):
        return 999999
    if q in ("worst", "min", "lowest"):
        return 1
    if q in ("4k", "2160", "2160p"):
        return 2160
    if q in ("2k", "1440", "1440p"):
        return 1440

    # Extract digits: '1080p60' -> 1080
    match = re.search(r"\d+", q)
    if match:
        return int(match.group(0))

    return 1080  # Default sensible target


def select_best_video_track(
    tracks: List[VideoTrack],
    target_height: int,
    prefer_combined: bool = False,
) -> Optional[VideoTrack]:
    """Selects the best video track using a soft-ceiling mathematical fallback.
    
    Algorithm:
    1. Filter tracks where height <= target_height.
    2. If candidates exist, select track maximizing: (height, fps, tbr).
    3. If no tracks meet height <= target_height, gracefully select the highest available.
    """
    if not tracks:
        return None

    valid_tracks = [t for t in tracks if t.url]
    if not valid_tracks:
        return None

    # Step 1: Candidates within target ceiling
    ceiling_candidates = [t for t in valid_tracks if t.height <= target_height and t.height > 0]
    pool = ceiling_candidates if ceiling_candidates else valid_tracks

    # Score function: (height, fps, total_bitrate, prefer_isolated_video)
    def score(t: VideoTrack) -> Tuple[int, int, float, int]:
        combined_pref = 1 if (prefer_combined == t.has_audio) else 0
        return (t.height or 0, t.fps or 0, t.tbr or 0.0, combined_pref)

    return max(pool, key=score)


def select_best_audio_track(
    tracks: List[AudioTrack],
    preferred_lang: Optional[str] = None,
) -> Optional[AudioTrack]:
    """Selects optimal audio track matching language and maximizing bitrate."""
    if not tracks:
        return None

    valid = [t for t in tracks if t.url]
    if not valid:
        return None

    # Language matching
    if preferred_lang:
        lang_clean = preferred_lang.strip().lower()
        lang_matches = [
            t for t in valid
            if t.language and (t.language.lower() == lang_clean or t.language.lower().startswith(lang_clean[:2]))
        ]
        if lang_matches:
            valid = lang_matches

    # Maximize bitrate and audio quality
    def score(t: AudioTrack) -> float:
        return t.abr or 0.0

    return max(valid, key=score)


def select_subtitles(
    tracks: List[SubtitleTrack],
    requested_langs: Optional[List[str]] = None,
) -> List[SubtitleTrack]:
    """Filters subtitles matching user's requested languages."""
    if not tracks or not requested_langs:
        return []

    selected: List[SubtitleTrack] = []
    seen_langs = set()

    for lang in requested_langs:
        l_clean = lang.strip().lower()
        for t in tracks:
            if t.language.lower() == l_clean or t.language.lower().startswith(l_clean[:2]):
                if t.language not in seen_langs:
                    selected.append(t)
                    seen_langs.add(t.language)
                    break

    return selected


def parse_manifest_dict(
    info: Dict[str, Any],
    quality: str | int = 1080,
    audio_only: bool = False,
    audio_lang: Optional[str] = None,
    sub_langs: Optional[List[str]] = None,
) -> VideoMetadata:
    """Parses raw yt-dlp info dictionary into typed VideoMetadata with score-based selection."""
    title = info.get("title") or "video"
    vid_id = info.get("id") or "unknown"
    webpage_url = info.get("webpage_url") or ""
    duration = int(info.get("duration") or 0)
    uploader = info.get("uploader") or info.get("channel") or "Unknown"
    thumbnail = info.get("thumbnail") or ""

    formats = info.get("formats") or []
    # Direct fallback: if no formats list but top-level url exists
    if not formats and info.get("url"):
        formats = [{
            "url": info.get("url"),
            "format_id": "direct",
            "ext": info.get("ext") or "mp4",
            "vcodec": info.get("vcodec") or "h264",
            "acodec": info.get("acodec") or "aac",
            "height": info.get("height") or 720,
            "width": info.get("width") or 1280,
            "filesize": info.get("filesize") or 0,
        }]

    all_videos: List[VideoTrack] = []
    all_audios: List[AudioTrack] = []

    audio_exts = ("m4a", "opus", "mp3", "aac", "ogg", "flac", "wav")
    video_exts = ("mp4", "webm", "mkv", "avi", "mov", "flv", "m4v", "ts")

    for f in formats:
        url = f.get("url")
        if not url:
            continue

        fid = str(f.get("format_id") or "")
        ext = str(f.get("ext") or "mp4").lower()
        vcodec = str(f.get("vcodec") or "none").lower()
        acodec = str(f.get("acodec") or "none").lower()
        height = int(f.get("height") or 0)
        width = int(f.get("width") or 0)
        fps = int(f.get("fps") or 0)
        filesize = int(f.get("filesize") or f.get("filesize_approx") or 0)
        tbr = float(f.get("tbr") or 0.0)
        abr = float(f.get("abr") or 0.0)
        lang = str(f.get("language") or "")

        # Infer resolution from resolution string or format_note if height is 0
        if height == 0:
            res_str = str(f.get("format_note") or f.get("resolution") or "")
            match = re.search(r"(\d{3,4})[pP]?", res_str)
            if match:
                height = int(match.group(1))

        is_pure_audio = ext in audio_exts or (vcodec in ("none", "") and acodec not in ("none", ""))
        
        # Track has video if not strictly audio-only
        has_video = not is_pure_audio and (vcodec not in ("none", "") or height > 0 or ext in video_exts or acodec in ("none", ""))
        # Combined track has audio if acodec is present or if it's a standard video container
        has_audio = acodec not in ("none", "") or (not is_pure_audio and ext in video_exts)

        if has_video:
            res_label = f"{height}p" if height else "standard"
            all_videos.append(
                VideoTrack(
                    format_id=fid,
                    ext=ext,
                    resolution=res_label,
                    height=height if height else 720,
                    width=width if width else 1280,
                    fps=fps,
                    vcodec=vcodec if vcodec != "none" else "h264",
                    url=url,
                    filesize=filesize,
                    tbr=tbr,
                    has_audio=has_audio,
                )
            )

        if has_audio and (is_pure_audio or vcodec in ("none", "")):
            all_audios.append(
                AudioTrack(
                    format_id=fid,
                    ext=ext,
                    language=lang,
                    abr=abr or tbr,
                    acodec=acodec if acodec != "none" else "aac",
                    url=url,
                    filesize=filesize,
                )
            )

    # Fallback safety: if no tracks were classified but formats exist with URLs
    if not all_videos and not all_audios and formats:
        for f in formats:
            if f.get("url"):
                all_videos.append(
                    VideoTrack(
                        format_id=str(f.get("format_id") or "fallback"),
                        ext=str(f.get("ext") or "mp4"),
                        resolution="standard",
                        height=720,
                        width=1280,
                        fps=30,
                        vcodec="h264",
                        url=f.get("url"),
                        filesize=int(f.get("filesize") or 0),
                        has_audio=True,
                    )
                )

    # Subtitles extraction
    all_subtitles: List[SubtitleTrack] = []
    subs_dict = info.get("subtitles") or {}
    auto_subs = info.get("automatic_captions") or {}

    for lang_code, sub_list in subs_dict.items():
        for s in sub_list:
            if s.get("url"):
                all_subtitles.append(
                    SubtitleTrack(
                        language=lang_code,
                        name=s.get("name") or lang_code,
                        url=s.get("url"),
                        ext=s.get("ext") or "vtt",
                        is_auto_generated=False,
                    )
                )

    for lang_code, sub_list in auto_subs.items():
        if lang_code not in subs_dict:  # Prefer manual over automatic
            for s in sub_list:
                if s.get("url"):
                    all_subtitles.append(
                        SubtitleTrack(
                            language=lang_code,
                            name=f"{lang_code} (auto)",
                            url=s.get("url"),
                            ext=s.get("ext") or "vtt",
                            is_auto_generated=True,
                        )
                    )

    # Selection logic
    target_height = parse_target_resolution(quality)
    selected_video: Optional[VideoTrack] = None
    if not audio_only:
        selected_video = select_best_video_track(all_videos, target_height)

    # Audio track selection
    selected_audio = select_best_audio_track(all_audios, preferred_lang=audio_lang)

    # If the chosen video track is already combined (has both video & audio),
    # and no explicit audio track was found or required, keep audio track optional
    if selected_video and selected_video.has_audio and not selected_audio:
        pass

    selected_subtitles = select_subtitles(all_subtitles, sub_langs)

    return VideoMetadata(
        title=title,
        id=vid_id,
        webpage_url=webpage_url,
        duration=duration,
        uploader=uploader,
        thumbnail=thumbnail,
        selected_video=selected_video,
        selected_audio=selected_audio,
        selected_subtitles=selected_subtitles,
        all_videos=all_videos,
        all_audios=all_audios,
        all_subtitles=all_subtitles,
    )


def resolve_video(
    url: str,
    quality: str | int = 1080,
    audio_only: bool = False,
    audio_lang: Optional[str] = None,
    sub_langs: Optional[List[str]] = None,
    custom_cookies: Optional[str] = None,
    browser_cookies: Optional[str] = None,
) -> VideoMetadata:
    """Resolves any platform video link (YouTube, Instagram, TikTok, Twitter) into direct stream URLs.
    
    Extracts metadata without downloading media bytes, with automated Cloudflare TLS impersonation.
    """
    import yt_dlp

    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "extractor_args": {"generic": {"impersonate": [""]}},
    }

    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget
        ydl_opts["impersonate"] = ImpersonateTarget.from_str("chrome")
    except Exception:
        pass

    temp_cookie_path = None
    if browser_cookies:
        ydl_opts["cookiesfrombrowser"] = (browser_cookies.lower().strip(), None, None, None)
    elif custom_cookies:
        if os.path.isfile(custom_cookies):
            ydl_opts["cookiefile"] = custom_cookies
        else:
            ydl_opts.setdefault("http_headers", {})["Cookie"] = custom_cookies
            try:
                import tempfile
                from urllib.parse import urlparse
                domain = urlparse(url).netloc.split(":")[0]
                temp_file = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt")
                temp_file.write("# Netscape HTTP Cookie File\n")
                for item in custom_cookies.split(";"):
                    if "=" in item:
                        k, v = item.strip().split("=", 1)
                        temp_file.write(f".{domain}\tTRUE\t/\tFALSE\t2147483647\t{k}\t{v}\n")
                temp_file.close()
                temp_cookie_path = temp_file.name
                ydl_opts["cookiefile"] = temp_cookie_path
            except Exception:
                pass

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info is None:
                raise ValueError(f"Failed to extract video metadata from: {url}")

            # If it's a playlist or multi-entry, pick the first entry
            if "entries" in info:
                entries = list(info["entries"])
                if not entries:
                    raise ValueError("Playlist contains no playable entries.")
                info = entries[0]
    finally:
        if temp_cookie_path and os.path.exists(temp_cookie_path):
            try:
                os.remove(temp_cookie_path)
            except OSError:
                pass

    return parse_manifest_dict(
        info,
        quality=quality,
        audio_only=audio_only,
        audio_lang=audio_lang,
        sub_langs=sub_langs,
    )
