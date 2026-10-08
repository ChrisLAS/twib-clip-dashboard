#!/usr/bin/env python3
"""Offline-first, single-host durable media producer. No account credentials or upload client."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

MAX_BYTES = 2 * 1024**3
MAX_SOURCE_MS = 6 * 60 * 60 * 1000
MAX_RENDER_MS = 15 * 60 * 1000
ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
FORMATS = "mov,matroska,mp3,wav,avi,ogg,flac"

class Blocked(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise Blocked("Expected a regular non-symlink file")
    return path


def atomic(path, data):
    if path.is_symlink():
        raise Blocked("Symlink state/output refused")
    tmp = path.with_name(path.name + ".new")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(canonical(data) + b"\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def integer(v, name, minimum=0):
    if type(v) is not int or v < minimum:
        raise Blocked(f"{name} must be an integer >= {minimum}")
    return v


def validate_job(j):
    if j.get("schemaVersion") != 1:
        raise Blocked("Unsupported job schema")
    for k in ("jobId", "clipId", "episodeId"):
        if not isinstance(j.get(k), str) or not ID.fullmatch(j[k]):
            raise Blocked(f"Invalid {k}")
    if not SHA.fullmatch(str(j.get("input", {}).get("sha256", ""))):
        raise Blocked("Input SHA-256 required")
    source = j["input"]
    for key, maximum in (("sourceTitle", 500), ("speaker", 200), ("edition", 200), ("context", 5000), ("longException", 2000)):
        if key in j and (not isinstance(j[key], str) or len(j[key]) > maximum):
            raise Blocked(f"Invalid {key}")
    for key in ("recordingDate", "publicationDate"):
        if j.get(key) is not None:
            try:
                if not isinstance(j[key], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", j[key]):
                    raise ValueError()
                timestamp = dt.datetime.fromisoformat(j[key].replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError) as e:
                raise Blocked(f"Invalid timezone-aware {key}") from e
    if j.get("sourceUrl") is not None:
        parsed = urllib.parse.urlsplit(j["sourceUrl"])
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise Blocked("Invalid public source URL")
    if j.get("supersedesAttemptId") is not None and not ID.fullmatch(j["supersedesAttemptId"]):
        raise Blocked("Invalid superseded attempt ID")
    if ("path" in source) == ("url" in source):
        raise Blocked("Exactly one input path or URL is required")
    if j.get("mode") not in ("cut", "already_cut"):
        raise Blocked("Explicit cut or already_cut mode required")
    integer(j.get("sourceInMs"), "sourceInMs")
    integer(j.get("sourceOutMs"), "sourceOutMs", 1)
    length = j["sourceOutMs"] - j["sourceInMs"]
    if length <= 0 or length > MAX_RENDER_MS:
        raise Blocked("Explicit source range must be positive and <= 15 minutes")
    if length > 180000 and not str(j.get("longException", "")).strip():
        raise Blocked("Over-three-minute clips require a written longException")
    integer(j.get("version", 1), "version", 1)
    if len(j.get("previousRenderIds", [])) >= 100 or any(not ID.fullmatch(x) for x in j.get("previousRenderIds", [])):
        raise Blocked("Invalid previous render history")
    for key, maximum in (("title", 500), ("summary", 5000), ("narrativeRole", 100)):
        if not isinstance(j.get(key), str) or len(j[key]) > maximum:
            raise Blocked(f"{key} must be text <= {maximum} characters")
    if "transcript" not in j:
        raise Blocked("Provide a timed transcript asset; transcription runtime is not configured")
    t = j["transcript"]
    if t.get("basis") not in ("source", "clip") or not SHA.fullmatch(str(t.get("sha256", ""))) or not t.get("path"):
        raise Blocked("Transcript requires path, SHA-256 and source/clip basis")


def local_asset(raw, root, max_bytes=MAX_BYTES):
    p = Path(raw)
    if not p.is_absolute():
        p = root / p
    # Reject each symlink component, not merely a final symlink.
    for parent in [p, *p.parents]:
        if parent.is_symlink():
            raise Blocked("Symlink input refused")
    p = p.resolve()
    if not p.is_relative_to(root):
        raise Blocked("Input is outside the operator-approved input root")
    regular(p)
    if p.stat().st_size > max_bytes:
        raise Blocked("Input exceeds byte limit")
    return p


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def _download(url, target, allow_hosts, max_bytes=MAX_BYTES, deadline_seconds=180):
    """No proxies, credentials, cookies, dynamic DNS reconnect, or cross-policy redirects."""
    deadline = time.monotonic() + deadline_seconds
    for _ in range(4):
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or host not in allow_hosts:
            raise Blocked("HTTPS URL/redirect host is not operator-approved")
        if parsed.fragment:
            raise Blocked("URL fragments are not supported")
        addresses = {r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
            raise Blocked("Non-public download address refused")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Blocked("Download deadline exceeded")
        conn = PinnedHTTPS(host, sorted(addresses)[0], min(15, remaining))
        try:
            conn.request("GET", urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, "")), headers={"Accept-Encoding": "identity", "User-Agent": "TWiB-local-producer/1"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise Blocked("Redirect without location")
                url = urllib.parse.urljoin(url, location)
                continue
            if response.status in (401, 403):
                raise Blocked("Source authorization required; no retries or bypass attempted")
            if response.status != 200:
                raise Blocked(f"Source HTTP {response.status}; retry only after operator review")
            if response.getheader("Content-Encoding", "identity") != "identity":
                raise Blocked("Encoded transfer refused")
            length = response.getheader("Content-Length")
            if length and int(length) > max_bytes:
                raise Blocked("Download exceeds byte limit")
            total = 0
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as f:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Blocked("Download deadline exceeded")
                    if conn.sock:
                        conn.sock.settimeout(min(15, remaining))
                    part = response.read1(256 * 1024)
                    if not part:
                        break
                    total += len(part)
                    if total > max_bytes:
                        raise Blocked("Download exceeds byte limit")
                    f.write(part)
                f.flush()
                os.fsync(f.fileno())
            if length and total != int(length):
                raise Blocked("Incomplete download")
            return
        finally:
            conn.close()
    raise Blocked("Redirect limit exceeded")


def download(url, target, allow_hosts, max_bytes=MAX_BYTES, deadline_seconds=180):
    # A process-wide wall timer also bounds slow-drip TLS/HTTP headers. CLI is single-threaded.
    def expired(signum, frame):
        raise Blocked("Download deadline exceeded")
    old_handler = signal.getsignal(signal.SIGALRM)
    old_timer = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, deadline_seconds)
    try:
        return _download(url, target, allow_hosts, max_bytes, deadline_seconds)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        if old_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


def run_tool(args, timeout=600, lock_fd=None):
    # Files avoid unbounded PIPE buffering; fail before logs exceed 8 MiB.
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout))

    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                              pass_fds=(() if lock_fd is None else (lock_fd,)), preexec_fn=limits) as p:
            deadline = time.monotonic() + timeout
            while p.poll() is None:
                if time.monotonic() > deadline or os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size > 8 * 1024 * 1024:
                    p.kill()
                    p.wait()
                    raise Blocked("Media tool deadline or log limit exceeded")
                time.sleep(0.02)
            if p.returncode:
                raise Blocked(f"{Path(args[0]).name} failed (exit {p.returncode})")
            if os.fstat(stdout.fileno()).st_size > 8 * 1024 * 1024:
                raise Blocked("Media tool output limit exceeded")
            stdout.seek(0)
            return stdout.read(8 * 1024 * 1024)


def probe(path, lock_fd=None):
    value = json.loads(run_tool(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, "-show_format", "-show_streams", "-of", "json", str(path)], 30, lock_fd))
    seconds = float(value.get("format", {}).get("duration", 0))
    if not math.isfinite(seconds) or seconds <= 0 or seconds * 1000 > MAX_SOURCE_MS:
        raise Blocked("Media duration is missing or exceeds six hours")
    streams = value.get("streams", [])
    if not any(s.get("codec_type") == "video" for s in streams):
        raise Blocked("A video stream is required")
    for stream in streams:
        if stream.get("codec_type") == "video" and (stream.get("width", 0) > 4096 or stream.get("height", 0) > 2160):
            raise Blocked("Video dimensions exceed bounded producer profile")
    return value, round(seconds * 1000)


def transcript_cues(j, root, duration):
    t = j["transcript"]
    path = local_asset(t["path"], root, 5 * 1024 * 1024)
    if digest(path) != t["sha256"]:
        raise Blocked("Transcript SHA-256 mismatch")
    cues = json.loads(path.read_text())
    if not isinstance(cues, list) or len(cues) > 5000:
        raise Blocked("Transcript must be an array of <= 5000 timed cues")
    result = []
    offset = j["sourceInMs"] if t["basis"] == "source" else 0
    previous = -1
    for i, cue in enumerate(cues):
        start = integer(cue.get("startMs"), "cue startMs")
        end = integer(cue.get("endMs"), "cue endMs", 1)
        if start < previous or end <= start or not isinstance(cue.get("text"), str) or len(cue["text"]) > 10000:
            raise Blocked("Invalid or unsorted transcript cue")
        previous = start
        # Whole-text cues straddling a cut cannot be truthfully trimmed automatically.
        if end <= offset or start >= offset + duration:
            continue
        if start < offset or end > offset + duration:
            raise Blocked("Transcript cue crosses cut boundary; supply word-timed or explicitly trimmed cues")
        result.append({"id": f"cue-{i}", "startMs": start - offset, "endMs": end - offset, "text": cue["text"]})
    if not result:
        raise Blocked("No timed transcript cues within the requested range")
    return result


class Producer:
    def __init__(self, job, state_root, input_root, allow_hosts=()):
        validate_job(job)
        self.job = job
        self.root = Path(state_root).absolute()
        for p in [self.root, *self.root.parents]:
            if p.is_symlink():
                raise Blocked("Symlink state root refused")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory = self.root / job["jobId"]
        if self.directory.is_symlink():
            raise Blocked("Symlink job directory refused")
        self.directory.mkdir(exist_ok=True, mode=0o700)
        self.input_root = Path(input_root).resolve(strict=True)
        self.allow_hosts = set(allow_hosts)
        self.path = self.directory / "state.json"
        self.fingerprint = hashlib.sha256(canonical(job)).hexdigest()
        self.state = None

    @contextlib.contextmanager
    def lock(self):
        fd = os.open(self.directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise Blocked("Job is held by another local process") from e
            self.lock_fd = fd
            yield
        finally:
            os.close(fd)

    def save(self):
        self.state["updatedAt"] = now()
        atomic(self.path, self.state)
        # Derived, replayable export. state.json is authoritative after any crash.
        atomic(self.directory / "events.json", {"schemaVersion": 1, "events": self.state["events"], "activations": self.state["activations"]})

    def event(self, stage, state="working", progress=False, blocker=None, checkpoint=None, persist=True):
        seq = sum(e["attemptId"] == self.state["attemptId"] for e in self.state["events"])
        event = {"schemaVersion": 1, "id": f"evt-{uuid.uuid4().hex}", "attemptId": self.state["attemptId"], "clipId": self.job["clipId"], "sequence": seq, "occurredAt": now(), "stage": stage, "state": state, "progress": progress, "nextExpectedAt": None, "blocker": blocker, "checkpoint": checkpoint}
        if len(self.state["events"]) >= 1900:
            raise Blocked("Event bound reached; archive and create an explicitly superseding job")
        self.state["events"].append(event)
        self.state["status"] = state
        if persist:
            self.save()

    def checkpoint(self, name, path):
        with open(path, "rb") as committed:
            os.fsync(committed.fileno())
        self.state["checkpoints"][name] = {"file": path.name, "sha256": digest(path), "size": path.stat().st_size}
        self.event(name, progress=True, checkpoint=f"sha256:{digest(path)}")

    def verified(self, name):
        record = self.state["checkpoints"].get(name)
        if not record:
            return None
        if Path(record["file"]).name != record["file"]:
            raise Blocked("Invalid checkpoint filename")
        path = regular(self.directory / record["file"])
        if path.stat().st_size != record["size"] or digest(path) != record["sha256"]:
            raise Blocked(f"{name} checkpoint corrupted; refusing unsafe resume")
        return path

    def load(self, retry):
        if self.path.exists():
            self.state = json.loads(regular(self.path).read_text())
            if self.state["jobHash"] != self.fingerprint:
                raise Blocked("Job ID already belongs to different immutable inputs")
            if self.state["status"] in ("blocked", "failed"):
                if not retry:
                    raise Blocked("Job blocked; address cause then explicitly use --retry")
                prior = self.state["attemptId"]
                attempt = "attempt-" + uuid.uuid4().hex
                self.state["attemptId"] = attempt
                self.state["activations"].append({"clipId": self.job["clipId"], "attemptId": attempt, "supersedes": prior})
                self.event("retry", "queued")
        else:
            attempt = "attempt-" + uuid.uuid4().hex
            self.state = {"schemaVersion": 1, "jobId": self.job["jobId"], "jobHash": self.fingerprint, "attemptId": attempt, "createdAt": now(), "status": "queued", "events": [], "activations": [{"clipId": self.job["clipId"], "attemptId": attempt, "supersedes": self.job.get("supersedesAttemptId")}], "checkpoints": {}}
            self.event("queued", "queued")

    def run(self, retry=False, stop_after=None):
        with self.lock():
            self.load(retry)
            try:
                # Every checkpoint is rehashed even on a completed idempotent replay.
                for name in self.state["checkpoints"]:
                    self.verified(name)
                if self.state["status"] == "ready" and self.verified("bundle"):
                    self.save()
                    return self.directory / "bundle.json"
                self.state["lease"] = {"host": socket.gethostname(), "pid": os.getpid(), "acquiredAt": now(), "mechanism": "flock; released on process death"}
                source = self.verified("source")
                if not source:
                    self.event("acquire")
                    source = self.directory / "source.media"
                    part = self.directory / "source.part"
                    if "path" in self.job["input"]:
                        original = local_asset(self.job["input"]["path"], self.input_root)
                        with open(original, "rb") as inp:
                            fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                            with os.fdopen(fd, "wb") as out:
                                copied = 0
                                while True:
                                    chunk = inp.read(1024 * 1024)
                                    if not chunk:
                                        break
                                    copied += len(chunk)
                                    if copied > MAX_BYTES:
                                        raise Blocked("Local copy exceeds byte limit")
                                    out.write(chunk)
                                out.flush()
                                os.fsync(out.fileno())
                    else:
                        download(self.job["input"]["url"], part, self.allow_hosts)
                    if digest(part) != self.job["input"]["sha256"]:
                        raise Blocked("Input SHA-256 mismatch")
                    os.replace(part, source)
                    self.state["retrievedAt"] = now()
                    self.checkpoint("source", source)
                if stop_after == "source":
                    return None
                _, source_duration = probe(source, self.lock_fd)
                desired = self.job["sourceOutMs"] - self.job["sourceInMs"]
                if self.job["mode"] == "cut" and self.job["sourceOutMs"] > source_duration:
                    raise Blocked("Cut range exceeds source duration")
                if self.job["mode"] == "already_cut" and abs(source_duration - desired) > 100:
                    raise Blocked("Already-cut duration disagrees with explicit original source range")
                cues = transcript_cues(self.job, self.input_root, desired)
                render = self.verified("render")
                if not render:
                    self.event("render")
                    part = self.directory / "render.part.mp4"
                    if part.is_symlink():
                        raise Blocked("Symlink render output refused")
                    args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "2", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, "-i", str(source)]
                    if self.job["mode"] == "cut":
                        args += ["-ss", str(self.job["sourceInMs"] / 1000)]
                    args += ["-t", str(desired / 1000), "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(part)]
                    run_tool(args, lock_fd=self.lock_fd)
                    render = self.directory / "render.mp4"
                    os.replace(part, render)
                    self.checkpoint("render", render)
                if stop_after == "render":
                    return None
                self.event("qa")
                metadata, duration = probe(render, self.lock_fd)
                if abs(duration - desired) > 100:
                    raise Blocked("Rendered duration exceeds 100 ms tolerance")
                if any(s.get("codec_name") not in ("h264", "aac") for s in metadata["streams"]):
                    raise Blocked("Unexpected output codec")
                run_tool(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", str(render), "-f", "null", "-"], lock_fd=self.lock_fd)
                if any(cue["endMs"] > duration for cue in cues):
                    raise Blocked("Transcript exceeds measured rendered duration")
                artifact_hash = digest(render)
                render_id = "render-" + hashlib.sha256((self.fingerprint + artifact_hash).encode()).hexdigest()[:40]
                checked = now()
                qa = [{"check": c, "result": "passed", "method": method, "checkedAt": checked, "artifactHash": artifact_hash} for c, method in (("artifact", "Local SHA-256 and byte count; Drive upload not performed"), ("container", "ffprobe MP4 metadata and full ffmpeg error-fatal decode"), ("codecs", "ffprobe H.264/AAC stream validation"), ("duration", "Explicit requested range within 100 ms of probed output"), ("mapping", "Single continuous explicit range; transcript cues validated inside range"))]
                qa += [{"check": c, "result": "unknown", "method": "Requires separate editorial/human review", "checkedAt": None, "artifactHash": artifact_hash} for c in ("listening", "lip-sync", "source-date", "context", "rights", "complete-argument")]
                source_meta = {"title": self.job.get("sourceTitle", self.job["title"]), "speaker": self.job.get("speaker", ""), "url": self.job.get("sourceUrl"), "edition": self.job.get("edition", ""), "recordingDate": self.job.get("recordingDate"), "publicationDate": self.job.get("publicationDate"), "retrievedAt": self.state["retrievedAt"], "inMs": self.job["sourceInMs"], "outMs": self.job["sourceOutMs"], "context": self.job.get("context", "")}
                record = {"id": render_id, "clipId": self.job["clipId"], "version": self.job.get("version", 1), "title": self.job["title"], "durationMs": duration, "createdAt": self.state["createdAt"], "recipeHash": self.fingerprint, "artifactHash": artifact_hash, "source": source_meta, "mappingVerified": True, "cues": cues, "qa": qa}
                clip = {k: self.job[k] for k in ("clipId", "episodeId", "title", "summary", "narrativeRole")}
                clip["id"] = clip.pop("clipId")
                clip.update(currentRenderId=render_id, renderIds=self.job.get("previousRenderIds", []) + [render_id])
                # No ready event is exported until QA passed; this is local completion, not import/upload.
                self.event("local_bundle", "ready", True, checkpoint=f"sha256:{artifact_hash}", persist=False)
                bundle = {"schemaVersion": 1, "jobId": self.job["jobId"], "jobHash": self.fingerprint, "longException": self.job.get("longException"), "localOnly": True, "uploadRequired": True, "artifact": {"path": "render.mp4", "sha256": artifact_hash, "size": render.stat().st_size, "kind": "original", "renderId": render_id}, "preservedInput": {"path": "source.media", "sha256": self.job["input"]["sha256"]}, "editMap": [{"renderInMs": 0, "renderOutMs": min(desired, duration), "sourceInMs": self.job["sourceInMs"], "sourceOutMs": self.job["sourceInMs"] + min(desired, duration)}], "timelineToleranceMs": 100, "manifestTemplate": {"schemaVersion": 1, "episodes": [], "clips": [clip], "renders": [record], "artifacts": [], "events": self.state["events"], "activations": self.state["activations"]}}
                atomic(self.directory / "bundle.json", bundle)
                self.state["checkpoints"]["bundle"] = {"file": "bundle.json", "sha256": digest(self.directory / "bundle.json"), "size": (self.directory / "bundle.json").stat().st_size}
                self.save()
                return self.directory / "bundle.json"
            except Exception as e:
                self.event("blocked", "blocked", blocker=str(e)[:2000])
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--allow-host", action="append", default=[], help="Exact operator-approved HTTPS download hostname; never inferred from job")
    parser.add_argument("--retry", action="store_true")
    parser.add_argument("--stop-after", choices=("source", "render"), help="Controlled restart drill; leaves job working")
    args = parser.parse_args()
    try:
        if args.job.stat().st_size > 1024 * 1024:
            raise Blocked("Job exceeds 1 MiB")
        result = Producer(json.loads(args.job.read_text()), args.state_root, args.input_root, args.allow_host).run(args.retry, args.stop_after)
        print(json.dumps({"bundle": str(result) if result else None, "status": "local_complete" if result else "checkpointed"}))
    except Exception as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
