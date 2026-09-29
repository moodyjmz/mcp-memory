#!/usr/bin/env python3
"""Remove the claude-memory-mcp instructions block from a CLAUDE.md file.

Earlier versions of setup.sh wrote that block into ~/.claude/CLAUDE.md. The instructions now come
from the server's MCP `instructions` field (src/instructions.ts), so the block only costs context.

Usage: remove-claude-md-block.py <path/to/CLAUDE.md>
Exit 0 when removed or absent; exit 1 (file untouched) when the markers don't pair up.
"""
import re
import sys

START = '<!-- claude-memory-mcp -->'
END = '<!-- /claude-memory-mcp -->'


def remove_block(text):
    """Return (new_text, removed). Raises ValueError when the markers don't pair up."""
    if START not in text and END not in text:
        return text, False
    if text.count(START) != 1 or text.count(END) != 1 or text.index(END) < text.index(START):
        raise ValueError('unmatched claude-memory-mcp markers')
    at_start = text[:text.index(START)].strip() == ''
    pattern = re.compile(r'\n*' + re.escape(START) + r'.*?' + re.escape(END) + r'[ \t]*\n?', re.S)
    new = pattern.sub('\n', text, count=1)
    if at_start:
        new = new.lstrip('\n')
    return ('' if new.strip() == '' else new), True


def main():
    path = sys.argv[1]
    with open(path) as f:
        text = f.read()
    try:
        new, removed = remove_block(text)
    except ValueError as e:
        print(f'    {e} in {path}: left unchanged', file=sys.stderr)
        sys.exit(1)
    if removed:
        with open(path, 'w') as f:
            f.write(new)
        print(f'    Removed the claude-memory-mcp block from {path}')
    else:
        print(f'    No claude-memory-mcp block in {path}')


if __name__ == '__main__':
    main()
