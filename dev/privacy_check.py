#!/usr/bin/env python3
"""Refuse text that would leak the maintainer's machine or accounts into the repository.

    python3 dev/privacy_check.py                 # the staged diff
    python3 dev/privacy_check.py --message "..." # a commit message as well

Flags e-mail addresses, the home directory, the user and host names, private
network addresses, and the names and e-mails of every ChatGPT login found in
the Codex homes on this machine. The identities are read at run time, so the
check itself never contains them. Findings name the file, line and kind only,
never the matched value.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "users.noreply.github.com", "anthropic.com")
EMAIL_RE = re.compile(r"[\w.+-]+@((?:[\w-]+\.)+[A-Za-z]{2,})\b")
# Loopback is the same on every machine, so it is not listed.
PRIVATE_IP_RE = re.compile(r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b")


def login_identities() -> set[str]:
    """Names and e-mails of the ChatGPT logins stored in any Codex home."""
    homes = {Path.home() / ".codex", Path.home() / ".codex-desktop"}
    if os.environ.get("CODEX_HOME"):
        homes.add(Path(os.environ["CODEX_HOME"]).expanduser())
    identities: set[str] = set()
    for home in homes:
        for path in [home / "auth.json", *home.glob(".codex-mod-accounts/*.json")]:
            try:
                data = json.loads(path.read_text())
                token = data.get("tokens", {}).get("id_token", "")
                payload = token.split(".")[1]
                claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            except (OSError, ValueError, IndexError, AttributeError):
                continue
            for value in (claims.get("email"), claims.get("name")):
                if isinstance(value, str) and len(value) >= 4:
                    identities.add(value)
                    identities.update(part for part in value.split() if len(part) >= 4)
    return identities


def patterns() -> list[tuple[str, re.Pattern]]:
    found = [
        ("home directory", re.compile(re.escape(str(Path.home())))),
        ("user name", re.compile(rf"\b{re.escape(getpass.getuser())}\b")),
        ("host name", re.compile(rf"\b{re.escape(socket.gethostname().split('.')[0])}\b", re.IGNORECASE)),
        ("private address", PRIVATE_IP_RE),
    ]
    found += [("login identity", re.compile(re.escape(value), re.IGNORECASE)) for value in sorted(login_identities())]
    return found


def scan(label: str, lines: list[tuple[int, str]], checks: list[tuple[str, re.Pattern]]) -> list[str]:
    findings = []
    for number, line in lines:
        for match in EMAIL_RE.finditer(line):
            if not match.group(1).lower().endswith(ALLOWED_EMAIL_DOMAINS):
                findings.append(f"{label}:{number}: e-mail address")
        for kind, pattern in checks:
            if pattern.search(line):
                findings.append(f"{label}:{number}: {kind}")
    return findings


def staged_lines() -> dict[str, list[tuple[int, str]]]:
    diff = subprocess.run(["git", "diff", "--cached", "-U0", "--no-color"], capture_output=True, text=True, check=True).stdout
    files: dict[str, list[tuple[int, str]]] = {}
    current, number = None, 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            number = int(re.search(r"\+(\d+)", line).group(1))
        elif current is not None and line.startswith("+"):
            files.setdefault(current, []).append((number, line[1:]))
            number += 1
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--message", help="Commit message to check as well")
    args = parser.parse_args()
    checks = patterns()
    findings = []
    for name, lines in staged_lines().items():
        findings += scan(name, lines, checks)
    if args.message:
        findings += scan("commit message", list(enumerate(args.message.splitlines(), 1)), checks)
    if findings:
        print("Personal data in what would be committed:", *findings, sep="\n  ")
        return 1
    print("privacy check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
