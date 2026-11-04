"""Regression checks for the standalone local streaming demo."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("continuous_demo", ROOT / "examples/continuous_demo.py")
demo_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo_module)


class ContinuousDemoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.profiles = {
            key: {**value, "deploymentId": "test-deployment", "deploymentUrl": "https://example.invalid"}
            for key, value in demo_module.RESOLUTION_PROFILES.items()
        }
        self.demo = demo_module.ContinuousDemo(self.profiles, "Will Smith eating spaghetti.", self.root)

    def tearDown(self):
        self.demo.stop()
        self.directory.cleanup()

    def test_resolution_matches_current_request_after_publication(self):
        self.demo.entries = [(0, 1.0, "media/test.ts", False)]
        self.assertEqual(self.demo.snapshot()["defaultResolution"], "512x320")
        self.demo.request("A new scene.", "448x256")
        self.assertEqual(self.demo.snapshot()["defaultResolution"], "448x256")
        self.assertEqual(self.demo.snapshot()["prompt"], "A new scene.")

    def test_cli_discovery_and_generation_use_account_login(self):
        with patch.dict(os.environ, {"COMFY_API_KEY": "node-key", "COMFY_CLOUD_API_KEY": "node-key"}):
            env = demo_module._cli_env()
        self.assertNotIn("COMFY_API_KEY", env)
        self.assertNotIn("COMFY_CLOUD_API_KEY", env)
        self.assertIn("PATH", env)

    def test_http_prompt_and_media_routes(self):
        media = self.demo.media_root / "clip-000001"
        media.mkdir()
        (media / "segment-00000.ts").write_bytes(b"test transport stream")
        server = demo_module.ThreadingHTTPServer(("127.0.0.1", 0), demo_module.make_handler(self.demo))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urllib.request.urlopen(base + "/live") as response:
                page = response.read().decode()
            self.assertIn('id="prompt"', page)
            self.assertIn('id="resolution"', page)
            self.assertIn('/static/hls.light.min.js', page)
            with urllib.request.urlopen(base + "/media/clip-000001/segment-00000.ts") as response:
                self.assertEqual(response.read(), b"test transport stream")
            request = urllib.request.Request(
                base + "/api/run", data=json.dumps({"prompt": "A new scene.", "resolution": "448x256"}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 202)
            self.assertEqual(self.demo.snapshot()["prompt"], "A new scene.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_stop_reaps_an_active_subprocess(self):
        errors = []
        def run_child():
            try:
                self.demo._run_process([sys.executable, "-c", "import time; time.sleep(60)"], timeout=70)
            except InterruptedError:
                pass
            except Exception as error:
                errors.append(error)
        self.demo.worker = threading.Thread(target=run_child)
        self.demo.start()
        deadline = time.monotonic() + 5
        while self.demo.active_process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        process = self.demo.active_process
        self.assertIsNotNone(process)
        self.demo.stop()
        self.assertIsNotNone(process.poll())
        self.assertFalse(self.demo.worker.is_alive())
        self.assertEqual(errors, [])

    def test_sliding_playlist_keeps_recently_retired_segments(self):
        def generate(_request, _work):
            if self.demo.attempt_count == 3:
                self.demo.stopping.set()
            return self.root / "unused.mp4"
        def segment(_video, number, _offset):
            directory = self.demo.media_root / f"clip-{number:06d}"
            directory.mkdir()
            path = directory / "segment.ts"
            path.write_bytes(b"transport stream")
            return [(0, 1.0, path.relative_to(self.root).as_posix())]
        with patch.object(demo_module, "MAX_PLAYLIST_SEGMENTS", 2), \
             patch.object(self.demo, "_generate", side_effect=generate), \
             patch.object(self.demo, "_segment", side_effect=segment):
            self.demo.start()
            self.demo.worker.join(timeout=5)
        self.assertFalse(self.demo.worker.is_alive())
        self.assertEqual(len(self.demo.entries), 2)
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:1", self.demo.playlist())
        self.assertEqual(len(self.demo.retired_segments), 1)
        self.assertTrue(self.demo.retired_segments[0][1].is_file())

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools are required")
    def test_repeated_clips_keep_audio_and_video_dts_in_order(self):
        source = self.root / "source.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "15.083333", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(source),
        ], check=True, timeout=15)
        with patch.object(self.demo, "_generate", return_value=source):
            self.demo.start()
            deadline = time.monotonic() + 15
            while self.demo.clip_count < 3 and time.monotonic() < deadline:
                time.sleep(0.05)
            self.demo.stop()
        self.assertGreaterEqual(self.demo.clip_count, 3, self.demo.error)
        self.assertNotIn("#EXT-X-ENDLIST", self.demo.playlist())

        for stream in ("v:0", "a:0"):
            previous_dts = None
            for _, _, uri, _ in self.demo.entries:
                output = subprocess.check_output([
                    "ffprobe", "-v", "error", "-select_streams", stream, "-show_packets",
                    "-show_entries", "packet=dts_time", "-of", "json", str(self.root / uri),
                ], text=True, timeout=5)
                for packet in json.loads(output)["packets"]:
                    if "dts_time" not in packet:
                        continue
                    dts = float(packet["dts_time"])
                    if previous_dts is not None:
                        self.assertGreater(dts, previous_dts, f"{stream}: overlap at {uri}")
                    previous_dts = dts


if __name__ == "__main__":
    unittest.main()
