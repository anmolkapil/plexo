"""Unit tests for the bonded video downloader and track orchestrator."""

from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from plexo.video.downloader import (
    BondedVideoDownloader,
    download_subtitle_track,
    sanitize_filename,
)
from plexo.video.resolver import AudioTrack, SubtitleTrack, VideoMetadata, VideoTrack


def test_sanitize_filename_special_chars():
    dirty = 'Epic Video: 4K / 60fps * [Review] <Part 1> "Uncut"? | Final.'
    clean = sanitize_filename(dirty)
    for bad in r'\/*?:"<>|':
        assert bad not in clean
    assert clean == "Epic Video 4K 60fps [Review] Part 1 Uncut Final"


def test_sanitize_filename_length_and_empty():
    long_name = "A" * 200
    cleaned = sanitize_filename(long_name, max_length=50)
    assert len(cleaned) == 50
    assert sanitize_filename("   ...   ") == "plexo_download"


def test_resolve_target_destination():
    meta_combined = VideoMetadata(
        title="Test Video",
        id="vid123",
        webpage_url="https://example.com/watch?v=vid123",
        duration=120,
        uploader="Plexo",
        selected_video=VideoTrack(
            format_id="137", ext="mp4", resolution="1080p", height=1080, width=1920,
            fps=30, vcodec="avc1", url="http://example.com/v.mp4", has_audio=True
        ),
        selected_audio=None,
    )

    downloader = BondedVideoDownloader(metadata=meta_combined)
    dest = downloader.resolve_target_destination()
    assert dest.name == "Test Video.mp4"

    # With custom output file
    downloader_custom = BondedVideoDownloader(metadata=meta_combined, output_path="custom_clip.mp4")
    assert downloader_custom.resolve_target_destination().name == "custom_clip.mp4"

    # Audio only destination
    meta_audio = VideoMetadata(
        title="Podcast Episode 1",
        id="aud123",
        webpage_url="https://example.com/audio",
        duration=300,
        uploader="Plexo",
        selected_video=None,
        selected_audio=AudioTrack(
            format_id="140", ext="m4a", language="en", abr=128.0,
            acodec="aac", url="http://example.com/a.m4a"
        ),
    )
    downloader_audio = BondedVideoDownloader(metadata=meta_audio)
    assert downloader_audio.resolve_target_destination().name == "Podcast Episode 1.m4a"


def test_download_audio_only(tmp_path):
    meta = VideoMetadata(
        title="Audio Track Only",
        id="aud1",
        webpage_url="https://example.com/audio",
        duration=60,
        uploader="Plexo",
        selected_video=None,
        selected_audio=AudioTrack(
            format_id="140", ext="m4a", language="en", abr=128.0,
            acodec="aac", url="http://example.com/a.m4a"
        ),
    )

    out_file = tmp_path / "audio_out.m4a"
    downloader = BondedVideoDownloader(metadata=meta, output_path=out_file)

    with patch("plexo.video.downloader.BondingDownloadEngine") as mock_engine_cls:
        mock_instance = MagicMock()
        mock_instance.execute.return_value = out_file
        mock_engine_cls.return_value = mock_instance

        stages = []
        result = downloader.download(stage_callback=lambda s, t: stages.append(s))

        assert result == out_file
        assert mock_instance.execute.called
        assert any("Audio" in s for s in stages)


def test_download_combined_video(tmp_path):
    meta = VideoMetadata(
        title="Combined Reel",
        id="reel1",
        webpage_url="https://instagram.com/reel/123",
        duration=30,
        uploader="Creator",
        selected_video=VideoTrack(
            format_id="mp4_muxed", ext="mp4", resolution="1080p", height=1080, width=1920,
            fps=30, vcodec="avc1", url="http://example.com/reel.mp4", has_audio=True
        ),
        selected_audio=None,
        selected_subtitles=[
            SubtitleTrack(language="en", name="English", url="http://example.com/sub.vtt")
        ],
    )

    out_file = tmp_path / "reel.mp4"
    downloader = BondedVideoDownloader(metadata=meta, output_path=out_file)

    with patch("plexo.video.downloader.BondingDownloadEngine") as mock_engine_cls, \
         patch("plexo.video.downloader.download_subtitle_track") as mock_sub:
        mock_instance = MagicMock()
        mock_instance.execute.return_value = out_file
        mock_engine_cls.return_value = mock_instance

        result = downloader.download()

        assert result == out_file
        assert mock_instance.execute.called
        assert mock_sub.called


def test_download_split_streams_with_muxer(tmp_path):
    meta = VideoMetadata(
        title="YouTube 4K Clip",
        id="yt4k",
        webpage_url="https://youtube.com/watch?v=yt4k",
        duration=180,
        uploader="Channel",
        selected_video=VideoTrack(
            format_id="313", ext="webm", resolution="2160p", height=2160, width=3840,
            fps=60, vcodec="vp9", url="http://example.com/video.webm", has_audio=False
        ),
        selected_audio=AudioTrack(
            format_id="251", ext="opus", language="en", abr=160.0,
            acodec="opus", url="http://example.com/audio.opus"
        ),
    )

    out_file = tmp_path / "final_clip.mkv"
    downloader = BondedVideoDownloader(metadata=meta, output_path=out_file)

    # Simulate download creating temp files
    temp_v = tmp_path / ".tmp_final_clip_video.webm"
    temp_a = tmp_path / ".tmp_final_clip_audio.opus"

    def fake_execute(*args, **kwargs):
        # Create temp files on disk
        temp_v.write_bytes(b"FAKE_VIDEO_STREAM")
        temp_a.write_bytes(b"FAKE_AUDIO_STREAM")
        return temp_v

    with patch("plexo.video.downloader.BondingDownloadEngine") as mock_engine_cls, \
         patch("plexo.video.downloader.is_ffmpeg_available", return_value=True), \
         patch("plexo.video.downloader.mux_media_streams") as mock_mux:

        mock_instance = MagicMock()
        mock_instance.execute.side_effect = [temp_v, temp_a]
        mock_engine_cls.return_value = mock_instance

        def fake_mux(video_path, audio_path, subtitle_paths, output_path):
            output_path.write_bytes(b"FAKE_MUXED_CONTAINER")
            return output_path

        mock_mux.side_effect = fake_mux

        result = downloader.download()

        assert result == out_file
        assert result.exists()
        assert mock_mux.called
        # Temp files should be cleaned up after successful muxing
        assert not temp_v.exists()
        assert not temp_a.exists()


def test_download_split_streams_fallback_without_ffmpeg(tmp_path):
    meta = VideoMetadata(
        title="YouTube 1080p Clip",
        id="yt1080",
        webpage_url="https://youtube.com/watch?v=yt1080",
        duration=120,
        uploader="Channel",
        selected_video=VideoTrack(
            format_id="137", ext="mp4", resolution="1080p", height=1080, width=1920,
            fps=30, vcodec="avc1", url="http://example.com/video.mp4", has_audio=False
        ),
        selected_audio=AudioTrack(
            format_id="140", ext="m4a", language="en", abr=128.0,
            acodec="aac", url="http://example.com/audio.m4a"
        ),
    )

    out_file = tmp_path / "my_clip.mp4"
    downloader = BondedVideoDownloader(metadata=meta, output_path=out_file)

    temp_v = tmp_path / ".tmp_my_clip_video.mp4"
    temp_a = tmp_path / ".tmp_my_clip_audio.m4a"
    temp_v.write_bytes(b"FAKE_VIDEO")
    temp_a.write_bytes(b"FAKE_AUDIO")

    with patch("plexo.video.downloader.BondingDownloadEngine") as mock_engine_cls, \
         patch("plexo.video.downloader.is_ffmpeg_available", return_value=False):

        mock_instance = MagicMock()
        mock_instance.execute.side_effect = [temp_v, temp_a]
        mock_engine_cls.return_value = mock_instance

        result = downloader.download()

        # Without ffmpeg, both tracks are cleanly preserved with suffix
        saved_video = tmp_path / "my_clip_video.mp4"
        saved_audio = tmp_path / "my_clip_audio.m4a"
        assert saved_video.exists()
        assert saved_audio.exists()
        assert result == saved_video


def test_cli_video_help():
    from click.testing import CliRunner
    from plexo.cli import main

    runner = CliRunner()
    result = runner.invoke(main, ["video", "--help"])
    assert result.exit_code == 0
    assert "Download universal videos" in result.output
    assert "--quality" in result.output
    assert "--audio-only" in result.output
    assert "--sub" in result.output
    assert "--list" in result.output


def test_cli_video_list_formats():
    from click.testing import CliRunner
    from plexo.cli import main

    meta = VideoMetadata(
        title="Sample Video",
        id="s123",
        webpage_url="https://youtube.com/watch?v=s123",
        duration=100,
        uploader="Plexo",
        all_videos=[
            VideoTrack(format_id="137", ext="mp4", resolution="1080p", height=1080, width=1920, fps=30, vcodec="h264", url="http://example.com/v1"),
            VideoTrack(format_id="136", ext="mp4", resolution="720p", height=720, width=1280, fps=30, vcodec="h264", url="http://example.com/v2"),
        ],
        all_audios=[
            AudioTrack(format_id="140", ext="m4a", language="en", abr=128.0, acodec="aac", url="http://example.com/a1"),
        ],
        all_subtitles=[
            SubtitleTrack(language="en", name="English", url="http://example.com/sub1"),
        ],
    )

    runner = CliRunner()
    with patch("plexo.cli.resolve_video", return_value=meta, create=True), \
         patch("plexo.video.resolver.resolve_video", return_value=meta):
        result = runner.invoke(main, ["video", "https://youtube.com/watch?v=s123", "--list"])
        assert result.exit_code == 0
        assert "Available Video Streams" in result.output
        assert "1080p" in result.output
        assert "Available Audio Streams" in result.output
        assert "Available Subtitles" in result.output


def test_cli_download_auto_delegation():
    from click.testing import CliRunner
    from plexo.cli import main

    runner = CliRunner()
    with patch("plexo.cli.video_download") as mock_video_cmd:
        result = runner.invoke(main, ["download", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
        assert "Media stream URL detected. Delegating to plexo video..." in result.output

