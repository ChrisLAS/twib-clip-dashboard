import copy
from concurrent.futures import ThreadPoolExecutor
import threading
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import producer as p
from finalize_manifest import finalize, publish_manifest


class ProducerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.source = Path(cls.fixture.name) / "fixture.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-c:a", "aac", str(cls.source)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.transcript = self.root / "transcript.json"
        self.transcript.write_text(json.dumps([{"startMs": 2100, "endMs": 3000, "text": "Synthetic test, not a real transcript."}, {"startMs": 3200, "endMs": 4900, "text": "Second fixture cue."}]))
        # Keep local files inside one explicit approved root.
        self.input = self.root / "source.mp4"
        self.input.write_bytes(self.source.read_bytes())
        self.job = {"schemaVersion": 1, "jobId": "job-a", "clipId": "clip-a", "episodeId": "episode-a", "input": {"path": "source.mp4", "sha256": p.digest(self.input)}, "mode": "cut", "sourceInMs": 2000, "sourceOutMs": 5000, "title": "Fixture", "summary": "Synthetic", "narrativeRole": "test", "transcript": {"path": "transcript.json", "sha256": p.digest(self.transcript), "basis": "source"}}

    def producer(self, job=None):
        return p.Producer(job or self.job, self.root / "state", self.root)

    def test_real_render_restart_idempotency_and_mapping(self):
        self.job["longException"] = "Explicit editorial rationale retained for inspection"
        worker = self.producer()
        self.assertIsNone(worker.run(stop_after="render"))
        source_hash = p.digest(worker.directory / "source.media")
        render_hash = p.digest(worker.directory / "render.mp4")
        worker = self.producer()
        with mock.patch.object(p, "run_tool", wraps=p.run_tool) as run:
            output = worker.run()
            self.assertFalse(any("libx264" in call.args[0] for call in run.call_args_list))
        bundle = json.loads(output.read_text())
        self.assertEqual(bundle["longException"], self.job["longException"])
        self.assertEqual(source_hash, self.job["input"]["sha256"])
        self.assertEqual(render_hash, bundle["artifact"]["sha256"])
        self.assertEqual(bundle["manifestTemplate"]["renders"][0]["cues"][0]["startMs"], 100)
        self.assertEqual(bundle["editMap"][0]["sourceInMs"], 2000)
        self.assertEqual(bundle["manifestTemplate"]["artifacts"], [])
        qa = {q["check"]: q["result"] for q in bundle["manifestTemplate"]["renders"][0]["qa"]}
        self.assertEqual(qa["listening"], "unknown")
        previous = output.read_bytes()
        self.assertEqual(self.producer().run().read_bytes(), previous)
        self.assertEqual(len(list(worker.directory.glob("render.mp4"))), 1)

    def test_dates_match_manifest_timestamp_grammar(self):
        for timestamp in ("2026-10-08 00:00:00+00:00", "2026-10-08T00:00:00+0000", "2026-02-30T00:00:00Z", "2026-10-08T00:00:00"):
            with self.subTest(timestamp=timestamp):
                for key in ("recordingDate", "publicationDate"):
                    with self.assertRaisesRegex(p.Blocked, "Invalid timezone-aware"):
                        p.validate_job({**self.job, key: timestamp})
        for timestamp in ("2026-10-08T00:00:00Z", "2026-10-08T00:00:00.123456+00:00", "2026-10-08T00:00:00-04:00"):
            p.validate_job({**self.job, "recordingDate": timestamp, "publicationDate": timestamp})

    def test_final_export_preserves_siblings_and_preexisting_destination(self):
        output = self.root / "manifest.json"
        sibling = self.root / "manifest.json.new"
        sibling.write_text("unrelated existing file")
        publish_manifest(output, {"first": True})
        before = output.read_bytes()
        with self.assertRaisesRegex(p.Blocked, "already exists"):
            publish_manifest(output, {"second": True})
        self.assertEqual(output.read_bytes(), before)
        self.assertEqual(sibling.read_text(), "unrelated existing file")
        self.assertEqual(list(self.root.glob(".manifest-*.tmp")), [])

    def test_concurrent_final_exports_publish_once(self):
        output = self.root / "manifest.json"
        barrier = threading.Barrier(2)
        def publish(value):
            barrier.wait()
            try:
                publish_manifest(output, {"winner": value})
                return value
            except p.Blocked:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(publish, [1, 2]))
        winners = [value for value in results if value is not None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(json.loads(output.read_text()), {"winner": winners[0]})
        self.assertEqual(list(self.root.glob(".manifest-*.tmp")), [])

    def test_manifest_receipt_and_bundle_tamper(self):
        output = self.producer().run()
        bundle = json.loads(output.read_text())
        receipt = {"fileId": "synthetic-drive-id", "sha256": bundle["artifact"]["sha256"], "size": bundle["artifact"]["size"]}
        manifest = finalize(output, receipt)
        self.assertEqual(manifest["artifacts"][0]["fileId"], "synthetic-drive-id")
        with self.assertRaisesRegex(p.Blocked, "exact output bytes"):
            finalize(output, {**receipt, "sha256": "0" * 64})
        output.write_text(json.dumps({**bundle, "jobId": "tampered"}))
        with self.assertRaisesRegex(p.Blocked, "verified completed"):
            finalize(output, receipt)

    def test_already_cut_and_clip_basis(self):
        self.job.update(mode="already_cut", sourceInMs=10000, sourceOutMs=18000)
        self.job["transcript"]["basis"] = "clip"
        bundle = json.loads(self.producer().run().read_text())
        self.assertEqual(bundle["manifestTemplate"]["renders"][0]["cues"][0]["startMs"], 2100)
        self.assertEqual(bundle["editMap"][0]["sourceInMs"], 10000)

    def test_wrong_hash_requires_explicit_retry(self):
        self.job["input"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(p.Blocked, "SHA-256"):
            self.producer().run()
        with self.assertRaisesRegex(p.Blocked, "--retry"):
            self.producer().run()
        with self.assertRaisesRegex(p.Blocked, "SHA-256"):
            self.producer().run(retry=True)
        state = json.loads((self.root / "state/job-a/state.json").read_text())
        self.assertEqual(len(state["activations"]), 2)
        self.assertEqual(state["activations"][1]["supersedes"], state["activations"][0]["attemptId"])

    def test_corrupt_checkpoint_and_job_mutation_refused(self):
        worker = self.producer()
        worker.run(stop_after="source")
        (worker.directory / "source.media").write_bytes(b"corrupt")
        with self.assertRaisesRegex(p.Blocked, "corrupted"):
            self.producer().run()
        altered = copy.deepcopy(self.job)
        altered["sourceInMs"] = 1000
        with self.assertRaisesRegex(p.Blocked, "immutable"):
            self.producer(altered).run()

    def test_lock_and_symlink_guards(self):
        worker = self.producer()
        with worker.lock():
            with self.assertRaisesRegex(p.Blocked, "another local process"):
                self.producer().run()
        (self.root / "link.mp4").symlink_to(self.input)
        with self.assertRaisesRegex(p.Blocked, "Symlink"):
            p.local_asset("link.mp4", self.root)
        with self.assertRaisesRegex(p.Blocked, "outside"):
            p.local_asset(self.source, self.root)
        (worker.directory / "state.json").symlink_to(self.transcript)
        with self.assertRaisesRegex(p.Blocked, "non-symlink"):
            self.producer().run()

    def test_boundary_cues_and_long_exception(self):
        self.job["sourceInMs"] = 2200
        with self.assertRaisesRegex(p.Blocked, "crosses cut"):
            self.producer().run()
        self.job["sourceOutMs"] = 200000
        with self.assertRaisesRegex(p.Blocked, "longException"):
            self.producer()

    def test_download_blocks_auth_private_redirect_and_size(self):
        target = self.root / "download.part"
        with self.assertRaisesRegex(p.Blocked, "operator-approved"):
            p.download("https://example.com/a", target, set())
        with mock.patch.object(p.socket, "getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            with self.assertRaisesRegex(p.Blocked, "Non-public"):
                p.download("https://example.com/a", target, {"example.com"})
        response = mock.Mock(status=403)
        with mock.patch.object(p.socket, "getaddrinfo", return_value=[(None, None, None, None, ("93.184.216.34", 443))]), mock.patch.object(p, "PinnedHTTPS") as conn:
            conn.return_value.getresponse.return_value = response
            with self.assertRaisesRegex(p.Blocked, "authorization required"):
                p.download("https://example.com/a", target, {"example.com"})
            self.assertEqual(conn.call_count, 1)
            response.status = 302
            response.getheader.return_value = "https://unapproved.example/a"
            with self.assertRaisesRegex(p.Blocked, "operator-approved"):
                p.download("https://example.com/a", target, {"example.com"})
            response.status = 200
            response.getheader.side_effect = lambda name, default=None: {"Content-Encoding": "identity", "Content-Length": "100"}.get(name, default)
            with self.assertRaisesRegex(p.Blocked, "byte limit"):
                p.download("https://example.com/a", target, {"example.com"}, max_bytes=10)

    def test_slow_header_deadline(self):
        with mock.patch.object(p, "_download", side_effect=lambda *args: time.sleep(2)):
            began = time.monotonic()
            with self.assertRaisesRegex(p.Blocked, "deadline"):
                p.download("https://example.com", self.root / "temp", {"example.com"}, deadline_seconds=0.05)
            self.assertLess(time.monotonic() - began, 0.5)

    def test_crash_before_bundle_commit_resumes(self):
        class PowerLoss(BaseException):
            pass
        real_atomic = p.atomic
        def interrupt_bundle(path, value):
            if path.name == "bundle.json":
                raise PowerLoss()
            return real_atomic(path, value)
        with mock.patch.object(p, "atomic", side_effect=interrupt_bundle):
            with self.assertRaises(PowerLoss):
                self.producer().run()
        state = json.loads((self.root / "state/job-a/state.json").read_text())
        self.assertNotEqual(state["status"], "ready")
        self.assertNotIn("bundle", state["checkpoints"])
        output = self.producer().run()
        self.assertTrue(output.exists())
        state = json.loads((self.root / "state/job-a/state.json").read_text())
        self.assertEqual(state["status"], "ready")
        self.assertEqual(sum(e["state"] == "ready" for e in state["events"]), 1)

    def test_actual_process_kill_and_resume(self):
        job_path = self.root / "job.json"
        job_path.write_text(json.dumps(self.job))
        command = ["python3", str(Path(p.__file__)), str(job_path), "--state-root", str(self.root / "state"), "--input-root", str(self.root)]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        state_path = self.root / "state/job-a/state.json"
        deadline = time.monotonic() + 10
        killed = False
        while time.monotonic() < deadline and process.poll() is None:
            if state_path.exists():
                state = json.loads(state_path.read_text())
                if any(e["stage"] == "render" for e in state["events"]):
                    process.kill()
                    killed = True
                    break
            time.sleep(0.001)
        process.communicate(timeout=10)
        self.assertTrue(killed, "Did not observe render stage for real SIGKILL drill")
        # ffmpeg inherits the lock so recovery waits until the orphan exits.
        deadline = time.monotonic() + 10
        while True:
            try:
                output = self.producer().run()
                break
            except p.Blocked as e:
                if "another local process" not in str(e) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        bundle = json.loads(output.read_text())
        self.assertEqual(bundle["artifact"]["sha256"], p.digest(output.parent / "render.mp4"))
        events = bundle["manifestTemplate"]["events"]
        self.assertEqual(len({e["id"] for e in events}), len(events))
        self.assertEqual([e["sequence"] for e in events], list(range(len(events))))


if __name__ == "__main__":
    unittest.main()
