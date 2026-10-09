"""Read saved canvas source with PAC; never save, publish, import or log output."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MAX_SOURCE = 2 * 1024 * 1024
MAX_ARCHIVE = 128 * 1024 * 1024


def fail(reason):
    # Never include subprocess diagnostics, paths, credentials or source values.
    return {"status": "source_unavailable", "reason": reason}


def run_pac(executable, arguments, timeout):
    # PAC failures can contain credential/session/connection details. Capture,
    # never print, and expose only closed-schema reason codes.
    result = subprocess.run([executable, *arguments], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False, shell=False)
    if result.returncode:
        raise RuntimeError("pac_read_failed")
    return result.stdout


def valid_source_entry(entry):
    if not isinstance(entry, str) or "\0" in entry:
        return False
    parts = re.split(r"[\\/]", entry)
    return (len(parts) >= 2 and parts[0] == "Src" and
            all(part not in ("", ".", "..") for part in parts) and
            entry.endswith(".pa.yaml"))


def extract_source(archive, entry):
    if not valid_source_entry(entry):
        raise RuntimeError("invalid_source_entry")
    if archive.stat().st_size > MAX_ARCHIVE:
        raise RuntimeError("archive_limit")
    with zipfile.ZipFile(archive) as package:
        matching = [item for item in package.infolist() if item.filename == entry]
        if len(matching) != 1 or matching[0].is_dir():
            raise RuntimeError("source_entry_missing_or_ambiguous")
        info = matching[0]
        if info.file_size > MAX_SOURCE:
            raise RuntimeError("source_limit")
        with package.open(info) as stream:
            raw = stream.read(MAX_SOURCE + 1)
        if len(raw) > MAX_SOURCE:
            raise RuntimeError("source_limit")
    # Read a single entry into memory; no zip extraction, traversal or symlinks.
    if raw.startswith(b"\xff\xfe"):
        content = raw[2:].decode("utf-16-le", errors="strict")
        encoding = "utf-16-le"
    elif raw.startswith(b"\xfe\xff"):
        content = raw[2:].decode("utf-16-be", errors="strict")
        encoding = "utf-16-be"
    else:
        content = raw.decode("utf-8-sig", errors="strict")
        encoding = "utf-8"
    return content, encoding, hashlib.sha256(raw).hexdigest()


def read_source(request):
    if not isinstance(request, dict):
        return fail("invalid_request")
    app = request.get("appId", "")
    environment = request.get("environment", "")
    entry = request.get("entry", "")
    if not GUID.fullmatch(app) or not GUID.fullmatch(environment):
        return fail("invalid_target")
    if not valid_source_entry(entry):
        return fail("invalid_source_entry")
    executable = request.get("pacExecutable", "pac")
    timeout = request.get("timeoutSeconds", 45)
    if not isinstance(timeout, int) or timeout <= 0 or timeout > 120:
        return fail("invalid_timeout")
    with tempfile.TemporaryDirectory(prefix="bridge-canvas-read-") as directory:
        os.chmod(directory, 0o700)
        archive = Path(directory) / "app.msapp"
        # Verify presence in the explicitly selected environment; no active
        # profile environment, partial name matching or inferred IDs are used.
        listing = run_pac(executable, ["canvas", "list", "--environment", environment], timeout)
        found_ids = {token.lower() for token in re.findall(rb"\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b", listing)}
        if app.lower().encode("ascii") not in found_ids:
            return fail("app_not_found_in_environment")
        run_pac(executable, ["canvas", "download", "--name", app,
                            "--environment", environment, "--file-name", str(archive)], timeout)
        if not archive.is_file():
            return fail("download_missing")
        os.chmod(archive, 0o600)
        content, encoding, raw_hash = extract_source(archive, entry)
        return {"status": "ok", "appId": app, "environment": environment,
                "entry": entry, "content": content, "encoding": encoding,
                "rawHash": raw_hash, "source": "power-apps-saved-msapp"}


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            result = fail("request_limit")
        else:
            result = read_source(json.loads(raw))
    except FileNotFoundError:
        result = fail("pac_unavailable")
    except subprocess.TimeoutExpired:
        result = fail("pac_timeout")
    except UnicodeError:
        result = fail("unsupported_encoding")
    except (ValueError, TypeError, OSError, RuntimeError, zipfile.BadZipFile):
        result = fail("source_read_failed")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
