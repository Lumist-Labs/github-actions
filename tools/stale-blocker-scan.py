#!/usr/bin/env python3
"""Find comments claiming a blocker whose issue/PR is already closed.

Not a TODO grep. It joins each run of consecutive comment lines into one block,
looks for language that asserts waiting on something, extracts the references,
and asks GitHub whether they are still open. A closed reference under blocker
language is a claim that quietly stopped being true.
"""
import json, re, subprocess, sys
from pathlib import Path

BLOCKER = re.compile(
    r'requires\s+\S*#\d+|blocked on|waiting on|must merge|leaving alone until'
    r'|revisit after|until\s+\S*#\d+\s+(lands|merges|is merged)|not until\s+\S*#\d+',
    re.I)
REF = re.compile(r'(?:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?#(\d+)')
COMMENT = re.compile(r'^\s*#')

def blocks(path):
    """Yield (first_lineno, joined_text) for each run of comment lines."""
    lines = path.read_text(errors='replace').splitlines()
    buf, start = [], None
    for i, ln in enumerate(lines, 1):
        if COMMENT.match(ln):
            if not buf: start = i
            buf.append(ln.strip().lstrip('#').strip())
        else:
            if buf: yield start, ' '.join(buf)
            buf, start = [], None
    if buf: yield start, ' '.join(buf)

_cache = {}
def closed(target, num):
    key = f'{target}#{num}'
    if key not in _cache:
        r = subprocess.run(['gh','api',f'repos/{target}/issues/{num}','--jq','.state'],
                           capture_output=True, text=True)
        _cache[key] = r.stdout.strip() if r.returncode == 0 else None
    return _cache[key] == 'closed'

def scan(root, repo_full):
    out = []
    for p in sorted(Path(root).rglob('*.y*ml')):
        for lineno, text in blocks(p):
            if not BLOCKER.search(text): continue
            for owner, num in REF.findall(text):
                target = owner or repo_full
                if closed(target, num):
                    rel = str(p).split('/.github/', 1)[-1]
                    out.append((repo_full, f'.github/{rel}', lineno,
                                f'{owner or ""}#{num}', text[:110]))
    return out

if __name__ == '__main__':
    print(json.dumps(scan(sys.argv[1], sys.argv[2])))
