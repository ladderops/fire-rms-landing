#!/usr/bin/env python3
"""Content checks for the LadderOps marketing site.

Two things nothing else was watching.

**Style.** This is public copy, and the house rules are American spelling,
no em-dashes, and plain quotes rather than typographic ones. That has
regressed more than once. A human reading a diff is not a reliable check
for a character that looks almost identical to the one it should be.

**Links.** Every internal href and src must resolve to a file that exists.
A renamed screenshot or a deleted page turns into a 404 that nobody sees
until a prospect does, because the site is static and nothing fails at
build time.

Both run over the HTML the site actually serves. Content inside <script>,
<style> and <code>/<pre> is exempt from the style rules: JSON-LD is
markup rather than prose, and a code sample may legitimately need a
backtick or a hyphen sequence.

Usage:
    python3 tools/check_content.py          # report and exit non-zero on failure
    python3 tools/check_content.py --list   # report only, always exit 0
"""

from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent

#: Directories whose contents are not part of the published site.
SKIP_DIRS = {".git", "node_modules", "tools", ".github"}

#: Typographic characters that should not appear in published copy.
#: Each maps to what to use instead, so the failure tells you the fix.
BANNED_CHARS = {
    "—": "em-dash: rewrite the sentence, or use a comma or parenthesis",
    "–": "en-dash: use a plain hyphen, or 'to' in a range",
    "“": "curly opening quote: use a plain double quote",
    "”": "curly closing quote: use a plain double quote",
    "‘": "curly opening apostrophe: use a plain single quote",
    "’": "curly apostrophe: use a plain single quote",
}

#: British spellings and their American forms. Matched case-insensitively
#: on whole words, so "organisation" is caught and "organist" is not.
BRITISH_SPELLINGS = {
    r"organis(e|ed|es|ing|ation|ations)": "organiz-",
    r"recognis(e|ed|es|ing)": "recogniz-",
    r"optimis(e|ed|es|ing|ation)": "optimiz-",
    r"prioritis(e|ed|es|ing)": "prioritiz-",
    r"specialis(e|ed|es|ing)": "specializ-",
    r"colour(s|ed|ing)?": "color",
    r"behaviour(s|al)?": "behavior",
    r"favour(s|ed|ite|ites)?": "favor",
    r"licence(s)?": "license",
    r"defence(s)?": "defense",
    r"centre(s|d)?": "center",
    r"catalogue(s|d)?": "catalog",
    r"analyse(s|d)?": "analyze",
    # Negative lookahead on the second 'l': the American base is
    # "fulfill"/"enroll", but both dialects write "fulfilling" and
    # "enrolling". Without this, the correct American gerund matches the
    # British base and the check reports a word that is already right.
    r"fulfil(?!l)(s|ment)?": "fulfill",
    r"enrol(?!l)(s|ment)?": "enroll",
    r"travell(ed|ing|er|ers)": "travel-",
    r"cancell(ed|ing)": "cancel-",
    r"judgement(s)?": "judgment",
    r"grey": "gray",
}


def html_files() -> list[Path]:
    out: list[Path] = []
    for path in ROOT.rglob("*.html"):
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        out.append(path)
    return sorted(out)


def visible_text(source: str) -> str:
    """The prose a reader sees, with markup and code stripped.

    ``<script>`` covers JSON-LD, which is structured data rather than
    copy. ``<code>`` and ``<pre>`` may legitimately contain characters
    the style rules ban.
    """
    stripped = re.sub(r"<(script|style|code|pre)\b.*?</\1>", " ", source, flags=re.S | re.I)
    stripped = re.sub(r"<!--.*?-->", " ", stripped, flags=re.S)
    return html.unescape(re.sub(r"<[^>]+>", " ", stripped))


def line_of(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def check_style(path: Path, source: str) -> list[str]:
    """Banned characters and British spellings in reader-visible prose.

    Offsets come from the stripped text, so they cannot be reported as
    source line numbers. The surrounding words locate it well enough, and
    a quoted fragment is easier to search for than a line number anyway.
    """
    problems: list[str] = []
    text = visible_text(source)

    for char, advice in BANNED_CHARS.items():
        for match in re.finditer(re.escape(char), text):
            start, end = max(0, match.start() - 45), min(len(text), match.end() + 45)
            fragment = " ".join(text[start:end].split())
            problems.append(f"{path.relative_to(ROOT)}: {advice}\n      ...{fragment}...")

    for pattern, american in BRITISH_SPELLINGS.items():
        for match in re.finditer(rf"\b{pattern}\b", text, flags=re.I):
            start, end = max(0, match.start() - 45), min(len(text), match.end() + 45)
            fragment = " ".join(text[start:end].split())
            problems.append(
                f"{path.relative_to(ROOT)}: British spelling '{match.group(0)}', use '{american}'\n      ...{fragment}..."
            )

    return problems


def check_links(path: Path, source: str) -> list[str]:
    """Every internal href and src resolves to a file on disk."""
    problems: list[str] = []
    for match in re.finditer(r"""\b(?:href|src)\s*=\s*["']([^"']+)["']""", source, flags=re.I):
        raw = match.group(1).strip()
        parsed = urlparse(raw)

        # External, protocol-relative, in-page anchors and non-file schemes.
        if parsed.scheme or raw.startswith("//") or raw.startswith("#") or not raw:
            continue
        if raw.startswith(("mailto:", "tel:", "data:", "javascript:")):
            continue

        target = unquote(parsed.path)
        if not target:
            continue

        base = ROOT if target.startswith("/") else path.parent
        resolved = (base / target.lstrip("/")).resolve()

        # A directory link is served by its index.html.
        if resolved.is_dir():
            resolved = resolved / "index.html"

        if not resolved.exists():
            problems.append(f"{path.relative_to(ROOT)}:{line_of(source, match.start())}: dead link '{raw}'")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="report findings but always exit 0")
    args = parser.parse_args()

    files = html_files()
    if not files:
        print("error: no HTML files found; the check would pass over nothing", file=sys.stderr)
        return 1

    style: list[str] = []
    links: list[str] = []
    for path in files:
        source = path.read_text(encoding="utf-8")
        style.extend(check_style(path, source))
        links.extend(check_links(path, source))

    print(f"checked {len(files)} HTML file(s)")

    if style:
        print(f"\nstyle ({len(style)}):")
        for problem in style:
            print(f"  {problem}")
    if links:
        print(f"\nlinks ({len(links)}):")
        for problem in links:
            print(f"  {problem}")

    if not style and not links:
        print("no problems found")
        return 0

    if args.list:
        return 0

    print(f"\n{len(style) + len(links)} problem(s). These are public copy, so they are worth fixing rather than muting.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
