"""Tests for the Plexo Video Stream Resolver and Quality Fallback Engine."""

import pytest
from plexo.video.resolver import (
    AudioTrack,
    SubtitleTrack,
    VideoMetadata,
    VideoTrack,
    parse_manifest_dict,
    parse_target_resolution,
    select_best_audio_track,
    select_best_video_track,
    select_subtitles,
)


def test_parse_target_resolution():
    assert parse_target_resolution("1080p") == 1080
    assert parse_target_resolution("1080") == 1080
    assert parse_target_resolution(1080) == 1080
    assert parse_target_resolution("720p") == 720
    assert parse_target_resolution("480") == 480
    assert parse_target_resolution("4k") == 2160
    assert parse_target_resolution("2160p") == 2160
    assert parse_target_resolution("2k") == 1440
    assert parse_target_resolution("best") == 999999
    assert parse_target_resolution("worst") == 1


def test_select_best_video_track_exact_match():
    tracks = [
        VideoTrack("1", "mp4", "360p", 360, 640, 30, "avc1", "http://vid/360.mp4"),
        VideoTrack("2", "mp4", "720p", 720, 1280, 30, "avc1", "http://vid/720.mp4"),
        VideoTrack("3", "mp4", "1080p", 1080, 1920, 30, "avc1", "http://vid/1080.mp4"),
        VideoTrack("4", "mp4", "1440p", 1440, 2560, 60, "vp9", "http://vid/1440.mp4"),
    ]

    selected = select_best_video_track(tracks, target_height=1080)
    assert selected is not None
    assert selected.height == 1080
    assert selected.format_id == "3"


def test_select_best_video_track_fallback_hierarchy():
    """If user requests 1080p, but video is capped at 720p, automatically falls back to 720p."""
    tracks = [
        VideoTrack("1", "mp4", "240p", 240, 426, 30, "avc1", "http://vid/240.mp4"),
        VideoTrack("2", "mp4", "360p", 360, 640, 30, "avc1", "http://vid/360.mp4"),
        VideoTrack("3", "mp4", "720p", 720, 1280, 30, "avc1", "http://vid/720.mp4"),
    ]

    selected = select_best_video_track(tracks, target_height=1080)
    assert selected is not None
    assert selected.height == 720
    assert selected.format_id == "3"


def test_select_best_video_track_fps_tiebreaker():
    """Between 1080p@30 and 1080p@60, prefers 1080p@60."""
    tracks = [
        VideoTrack("1080_30", "mp4", "1080p", 1080, 1920, 30, "avc1", "http://vid/1080_30.mp4", tbr=2500.0),
        VideoTrack("1080_60", "mp4", "1080p", 1080, 1920, 60, "avc1", "http://vid/1080_60.mp4", tbr=4500.0),
    ]

    selected = select_best_video_track(tracks, target_height=1080)
    assert selected is not None
    assert selected.format_id == "1080_60"
    assert selected.fps == 60


def test_select_best_audio_track_bitrate():
    audios = [
        AudioTrack("a1", "m4a", "en", 64.0, "mp4a", "http://audio/64.m4a"),
        AudioTrack("a2", "m4a", "en", 128.0, "mp4a", "http://audio/128.m4a"),
        AudioTrack("a3", "opus", "en", 160.0, "opus", "http://audio/160.opus"),
    ]

    selected = select_best_audio_track(audios)
    assert selected is not None
    assert selected.format_id == "a3"
    assert selected.abr == 160.0


def test_select_best_audio_track_language():
    audios = [
        AudioTrack("a_en", "m4a", "en", 128.0, "mp4a", "http://audio/en.m4a"),
        AudioTrack("a_hi", "m4a", "hi", 128.0, "mp4a", "http://audio/hi.m4a"),
        AudioTrack("a_es", "m4a", "es", 128.0, "mp4a", "http://audio/es.m4a"),
    ]

    selected = select_best_audio_track(audios, preferred_lang="hi")
    assert selected is not None
    assert selected.format_id == "a_hi"
    assert selected.language == "hi"


def test_select_subtitles():
    subs = [
        SubtitleTrack("en", "English", "http://subs/en.vtt", "vtt"),
        SubtitleTrack("hi", "Hindi", "http://subs/hi.vtt", "vtt"),
        SubtitleTrack("es", "Spanish", "http://subs/es.vtt", "vtt"),
    ]

    selected = select_subtitles(subs, requested_langs=["hi", "es"])
    assert len(selected) == 2
    assert {s.language for s in selected} == {"hi", "es"}


def test_parse_manifest_dict_full_integration():
    mock_info = {
        "title": "Quantum Physics Explained in 10 Minutes",
        "id": "dQw4w9WgXcQ",
        "duration": 600,
        "uploader": "ScienceChannel",
        "webpage_url": "https://example.com/video/123",
        "formats": [
            {
                "format_id": "v360",
                "ext": "mp4",
                "vcodec": "avc1.4d401e",
                "acodec": "none",
                "height": 360,
                "width": 640,
                "fps": 30,
                "tbr": 400.0,
                "url": "http://stream/v360.mp4",
            },
            {
                "format_id": "v720",
                "ext": "mp4",
                "vcodec": "avc1.4d401f",
                "acodec": "none",
                "height": 720,
                "width": 1280,
                "fps": 30,
                "tbr": 1200.0,
                "url": "http://stream/v720.mp4",
            },
            {
                "format_id": "v1080",
                "ext": "mp4",
                "vcodec": "avc1.640028",
                "acodec": "none",
                "height": 1080,
                "width": 1920,
                "fps": 60,
                "tbr": 3500.0,
                "url": "http://stream/v1080.mp4",
            },
            {
                "format_id": "a_en",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 128.0,
                "language": "en",
                "url": "http://stream/audio_en.m4a",
            },
            {
                "format_id": "a_hi",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 128.0,
                "language": "hi",
                "url": "http://stream/audio_hi.m4a",
            },
        ],
        "subtitles": {
            "en": [{"url": "http://subs/en.vtt", "ext": "vtt", "name": "English"}],
            "hi": [{"url": "http://subs/hi.vtt", "ext": "vtt", "name": "Hindi"}],
        },
    }

    # Request 1080p + Hindi audio + English subtitles
    meta = parse_manifest_dict(
        mock_info,
        quality=1080,
        audio_lang="hi",
        sub_langs=["en"],
    )

    assert meta.title == "Quantum Physics Explained in 10 Minutes"
    assert meta.uploader == "ScienceChannel"
    assert meta.selected_video is not None
    assert meta.selected_video.format_id == "v1080"
    assert meta.selected_video.height == 1080

    assert meta.selected_audio is not None
    assert meta.selected_audio.format_id == "a_hi"
    assert meta.selected_audio.language == "hi"

    assert len(meta.selected_subtitles) == 1
    assert meta.selected_subtitles[0].language == "en"


def test_parse_manifest_audio_only():
    mock_info = {
        "title": "Podcast Episode 42",
        "id": "pod42",
        "formats": [
            {
                "format_id": "v720",
                "height": 720,
                "vcodec": "avc1",
                "acodec": "none",
                "url": "http://stream/v.mp4",
            },
            {
                "format_id": "audio_best",
                "vcodec": "none",
                "acodec": "opus",
                "abr": 160.0,
                "url": "http://stream/a.opus",
            },
        ],
    }

    meta = parse_manifest_dict(mock_info, audio_only=True)
    assert meta.selected_video is None
    assert meta.selected_audio is not None
    assert meta.selected_audio.format_id == "audio_best"


def test_resolve_video_cookies_options(tmp_path):
    from unittest.mock import MagicMock, patch
    from plexo.video.resolver import resolve_video

    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text("# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t2147483647\tcf_clearance\tabc123\n")

    mock_info = {
        "title": "Protected Clip",
        "id": "p123",
        "formats": [
            {"format_id": "v1080", "height": 1080, "vcodec": "avc1", "acodec": "none", "url": "http://stream/v.mp4"},
            {"format_id": "a1", "vcodec": "none", "acodec": "aac", "abr": 128.0, "url": "http://stream/a.m4a"},
        ],
    }

    with patch("yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_instance = MagicMock()
        mock_instance.__enter__.return_value = mock_instance
        mock_instance.extract_info.return_value = mock_info
        mock_ydl_cls.return_value = mock_instance

        # Test with cookie file path
        res1 = resolve_video("https://example.com/video", custom_cookies=str(cookie_file))
        assert res1.title == "Protected Clip"

        # Test with raw cookie string
        res2 = resolve_video("https://example.com/video", custom_cookies="cf_clearance=abc123; other=val")
        assert res2.title == "Protected Clip"

