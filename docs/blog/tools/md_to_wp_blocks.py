#!/usr/bin/env python3
"""Convert the small Markdown subset used in docs/blog drafts into WordPress
(Gutenberg) block markup, standard library only.

Why this exists: the blog is a self-hosted WordPress that the WordPress.com
connector cannot reach, and pasting raw Markdown into the block editor loses
tables and code blocks. Paste this script's output into the editor's
"Code editor" (⋮ → コードエディター) instead and every block is created at once.

Usage:  md_to_wp_blocks.py article.md [media.json]  >  article.wp.html
        (the first '# ' line is the post title: it is printed to stderr and
         NOT included in the content)

Supported: ## / ### headings, paragraphs, **bold**, `code`, [text](url),
> quotes, - / 1. lists, | tables |, ``` fenced code, --- rule,
![alt](media:FILE.png) images (id + url looked up in media.json, i.e. files already
uploaded to the WordPress media library),
::: memo ... ::: boxes, and 【画像：...】 placeholder lines (highlighted).
"""

from __future__ import annotations

import html
import re
import sys


def inline(text: str) -> str:
    """Escape HTML, then apply inline code, bold and links."""
    codes: list[str] = []

    def stash(m: re.Match) -> str:
        codes.append("<code>" + html.escape(m.group(1), quote=False) + "</code>")
        return f"\u0000{len(codes) - 1}\u0000"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(
        r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
        lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>',
        text,
    )
    return re.sub(r"\u0000(\d+)\u0000", lambda m: codes[int(m.group(1))], text)


MEDIA: dict = {}


def image_block(alt: str, fname: str) -> str:
    if fname not in MEDIA:
        raise SystemExit(f"image {fname!r} is not in the media map")
    m = MEDIA[fname]
    a = html.escape(alt, quote=True)
    return (
        f'<!-- wp:image {{"id":{m["id"]},"sizeSlug":"large","linkDestination":"none"}} -->\n'
        f'<figure class="wp-block-image size-large"><img src="{html.escape(m["url"], quote=True)}" '
        f'alt="{a}" class="wp-image-{m["id"]}"/><figcaption class="wp-element-caption">{html.escape(alt)}</figcaption></figure>\n'
        "<!-- /wp:image -->"
    )


def para(text: str) -> str:
    body = "<br>".join(inline(line) for line in text.split("\n"))
    if text.startswith("【画像"):
        body = f"<mark>{body}</mark>"
    return f"<!-- wp:paragraph -->\n<p>{body}</p>\n<!-- /wp:paragraph -->"


def heading(level: int, text: str) -> str:
    attrs = "" if level == 2 else f' {{"level":{level}}}'
    return (
        f"<!-- wp:heading{attrs} -->\n<h{level} class=\"wp-block-heading\">{inline(text)}</h{level}>\n"
        f"<!-- /wp:heading -->"
    )


def code_block(lines: list[str]) -> str:
    code = html.escape("\n".join(lines), quote=False)
    return (
        '<!-- wp:code -->\n<pre class="wp-block-code"><code>' + code + "</code></pre>\n<!-- /wp:code -->"
    )


def list_block(items: list[str], ordered: bool) -> str:
    tag = "ol" if ordered else "ul"
    attr = ' {"ordered":true}' if ordered else ""
    lis = "\n".join(
        f"<!-- wp:list-item -->\n<li>{inline(i)}</li>\n<!-- /wp:list-item -->" for i in items
    )
    return f"<!-- wp:list{attr} -->\n<{tag} class=\"wp-block-list\">\n{lis}\n</{tag}>\n<!-- /wp:list -->"


def quote_block(lines: list[str]) -> str:
    inner = "\n".join(para(l) for l in lines)
    return f'<!-- wp:quote -->\n<blockquote class="wp-block-quote">\n{inner}\n</blockquote>\n<!-- /wp:quote -->'


def table_block(rows: list[list[str]]) -> str:
    head, body = rows[0], rows[1:]
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    trs = "\n".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
    return (
        '<!-- wp:table -->\n<figure class="wp-block-table"><table class="has-fixed-layout">'
        f"<thead><tr>{th}</tr></thead>\n<tbody>\n{trs}\n</tbody></table></figure>\n<!-- /wp:table -->"
    )


def parse(lines: list[str]) -> tuple[str, list[str]]:
    """Parse Markdown lines into (title, list of block strings)."""
    title = ""
    blocks: list[str] = []
    i = 0

    def collect_paragraph(start: int) -> tuple[str, int]:
        buf = []
        j = start
        while j < len(lines) and lines[j].strip() and not re.match(
            r"^(#{1,3} |> |- |\d+\. |```|\||---$|:::|!\[)", lines[j]
        ):
            buf.append(lines[j].rstrip())
            j += 1
        return "\n".join(buf), j

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("# ") and not title:
            title = line[2:].strip()
            i += 1
        elif line.startswith("### "):
            blocks.append(heading(3, line[4:].strip())); i += 1
        elif line.startswith("## "):
            blocks.append(heading(2, line[3:].strip())); i += 1
        elif line.strip() == "---":
            blocks.append('<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->'); i += 1
        elif line.startswith("```"):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("```"):
                j += 1
            blocks.append(code_block(lines[i + 1 : j])); i = j + 1
        elif line.startswith(":::"):
            j = i + 1
            while j < len(lines) and lines[j].strip() != ":::":
                j += 1
            inner = parse(lines[i + 1 : j])[1]
            blocks.append(
                '<!-- wp:group {"style":{"border":{"width":"2px","color":"#d9a400"},"spacing":{"padding":{"top":"1em","bottom":"1em","left":"1em","right":"1em"}}}} -->\n'
                '<div class="wp-block-group has-border-color" style="border-color:#d9a400;border-width:2px;padding-top:1em;padding-right:1em;padding-bottom:1em;padding-left:1em">\n'
                + "\n".join(inner)
                + "\n</div>\n<!-- /wp:group -->"
            )
            i = j + 1
        elif re.match(r"^!\[.*\]\(media:.+\)\s*$", line):
            m = re.match(r"^!\[(.*)\]\(media:(.+?)\)\s*$", line)
            blocks.append(image_block(m.group(1), m.group(2))); i += 1
        elif line.startswith("> "):
            j = i
            q = []
            while j < len(lines) and lines[j].startswith("> "):
                q.append(lines[j][2:].strip()); j += 1
            blocks.append(quote_block(q)); i = j
        elif line.startswith("|"):
            j = i
            rows: list[list[str]] = []
            while j < len(lines) and lines[j].startswith("|"):
                cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                    rows.append(cells)
                j += 1
            blocks.append(table_block(rows)); i = j
        elif re.match(r"^- ", line) or re.match(r"^\d+\. ", line):
            ordered = bool(re.match(r"^\d+\. ", line))
            pat = r"^\d+\. " if ordered else r"^- "
            j = i
            items = []
            while j < len(lines) and re.match(pat, lines[j]):
                items.append(re.sub(pat, "", lines[j]).strip()); j += 1
            blocks.append(list_block(items, ordered)); i = j
        else:
            text, j = collect_paragraph(i)
            if not text:  # safety: never loop forever on an unrecognised line
                text, j = line.rstrip(), i + 1
            blocks.append(para(text)); i = j

    return title, blocks


def convert(md: str) -> tuple[str, str]:
    title, blocks = parse(md.splitlines())
    return title, "\n\n".join(blocks)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    if len(sys.argv) == 3:
        import json

        with open(sys.argv[2], encoding="utf-8") as fh:
            MEDIA.update(json.load(fh))
    with open(sys.argv[1], encoding="utf-8") as fh:
        post_title, content = convert(fh.read())
    print(f"TITLE: {post_title}", file=sys.stderr)
    print(content)
