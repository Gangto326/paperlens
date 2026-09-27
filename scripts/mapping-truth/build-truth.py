#!/usr/bin/env python3
"""정답 매핑 표본 생성기 (C1.21). 개발용 도구이며 앱과 `npm run check`는 이 파일을 쓰지 않는다.

사용:
    PAPERLENS_TRUTH_DUMP=/tmp/truth-dump npm run eval:mapping     # 입력 덤프
    python3 scripts/mapping-truth/build-truth.py /tmp/truth-dump   # fixtures/truth/mapping.<id>.json
    python3 scripts/mapping-truth/build-truth.py /tmp/truth-dump --review > review.txt

원칙: 정답은 매핑 알고리즘(C1.11 후보 검색, C1.12 정렬)과 다른 경로로 만든다.
- 입력 덤프에는 텍스트 항목과 문장 글(enRaw)만 있다. 매핑 결과와 GROBID 좌표는 없다.
- 문서 전체 항목을 (page, index) 순으로 이어 붙이고 문자·숫자만 남긴 키 문자열에서
  문장의 키 문자열을 전역 검색한다. 위치를 좁히는 데 좌표를 쓰지 않는다.
- 유일하게 일치하면 그 위치가 초안이다(unique).
- 여러 번 나오면 TEI 문장 순서에서 앞뒤 유일 문장의 위치 사이에 있는 하나를 고른다(repeated_by_order).
- 일치가 없으면 가장 긴 접두사부터 구간을 나눠 찾는다(segmented). 구간 사이의 틈은
  쪽 번호·머리말·각주·그림 설명이거나, 파서가 떨어진 글을 이어 붙인 경우다.
- 그래도 못 찾으면 annotations.json에 사람이 범위를 적는다(manual).

한계:
- 문장 글은 GROBID가 준 것이다. 파서가 문장을 잘못 자르거나 이어 붙였으면 정답도 그 글을 따른다.
- 키 문자열에 구두점이 없으므로 스팬 양끝의 구두점 위치는 정답에 없다. 비교도 문자·숫자만 한다.
- 알고리즘과 정답 모두 문자열 일치에 기대므로, PDF 글자 자체가 틀린 경우(글꼴 대응 오류)는 둘 다 못 잡는다.
"""
import hashlib
import json
import os
import re
import sys
import unicodedata
from bisect import bisect_right
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MIN_SEG = 12
WINDOW = 8000
CHECKED_PER_PAPER = 80
MATH = re.compile('[Ͱ-Ͽ∀-⋿⨀-⫿\U0001d400-\U0001d7ff]')
HARD = {
    'page_boundary',
    'column_boundary',
    'repeated',
    'inline_math',
    'gapped',
    'parser_defect',
    'short',
    'script',
    'url',
}

METHOD = (
    '문서 전체 텍스트 항목을 (page, index) 순으로 이어 붙여 문자·숫자만 남긴 키 문자열을 만들고, '
    '문장 글(GROBID enRaw)의 키 문자열을 전역 검색했다. 좌표와 매핑 알고리즘 출력은 쓰지 않았다. '
    'verification이 read인 항목은 스팬 글·틈·앞뒤 항목을 읽어 문장 글과 대조했고, '
    'manual인 항목은 항목 문자열을 읽어 범위를 직접 정했다. auto는 유일 일치만 확인한 보조 자료다.'
)
LIMITS = [
    '사람이 PDF 화면을 보고 표시한 정답이 아니다. 자동 초안을 Claude가 텍스트로 읽어 검수했다.',
    '문장 글은 GROBID 출력이다. 파서가 잘못 자르거나 이어 붙인 문장은 그 글을 기준으로 정답을 만들고 parser_defect로 표시했다.',
    '비교는 문자·숫자 글자만 한다. 스팬 양끝의 공백·구두점·하이픈 위치는 검증하지 않는다.',
    '정답과 알고리즘이 모두 문자열 일치에 기대므로 PDF 글자 자체의 오류는 드러나지 않는다.',
]


def key_chars(ch):
    out = []
    for c in unicodedata.normalize('NFKD', ch):
        if unicodedata.category(c)[0] in 'LN':
            for l in c.lower():
                if unicodedata.category(l)[0] in 'LN':
                    out.append(l)
    return out


def is_key(ch):
    return any(unicodedata.category(c)[0] in 'LN' for c in unicodedata.normalize('NFKD', ch))


def keyify(text):
    return ''.join(''.join(key_chars(ch)) for ch in text)


def build_stream(items):
    keys, owner = [], []
    for ii, it in enumerate(items):
        off = 0
        for ch in it['str']:
            n = 2 if ord(ch) > 0xFFFF else 1
            for k in key_chars(ch):
                keys.append(k)
                owner.append((ii, off, n))
            off += n
    return ''.join(keys), owner


def find_all(hay, needle, lo=0, hi=None):
    res = []
    hi = len(hay) if hi is None else hi
    p = hay.find(needle, lo, hi)
    while p != -1:
        res.append(p)
        p = hay.find(needle, p + 1, hi)
    return res


def longest_prefix(hay, needle, lo, hi):
    a, b = 0, len(needle)
    while a < b:
        m = (a + b + 1) // 2
        if hay.find(needle[:m], lo, hi) != -1:
            a = m
        else:
            b = m - 1
    return a, (find_all(hay, needle[:a], lo, hi) if a > 0 else [])


def spans_of_segments(owner, segs):
    spans = []
    for s, e in segs:
        cur = None
        for k in range(s, e):
            ii, off, n = owner[k]
            if cur and cur[0] == ii:
                cur[2] = max(cur[2], off + n)
            else:
                if cur:
                    spans.append(cur)
                cur = [ii, off, off + n]
        if cur:
            spans.append(cur)
    return spans


def utf16_slice(s, a, b):
    return s.encode('utf-16-le')[a * 2 : b * 2].decode('utf-16-le', 'replace')


def utf16_len(s):
    return len(s.encode('utf-16-le')) // 2


def spans_of_ranges(items, pos_of, ranges):
    """annotations.json의 ranges: [시작 항목, 시작 offset, 끝 항목, 끝 offset] → 글자가 있는 항목별 범위."""
    spans = []
    for a_id, a_off, b_id, b_off in ranges:
        for ii in range(pos_of[a_id], pos_of[b_id] + 1):
            s = items[ii]['str']
            lo = a_off if ii == pos_of[a_id] else 0
            hi = b_off if ii == pos_of[b_id] else utf16_len(s)
            first = last = None
            off = 0
            for ch in s:
                n = 2 if ord(ch) > 0xFFFF else 1
                if lo <= off < hi and is_key(ch):
                    first = off if first is None else first
                    last = off + n
                off += n
            if first is not None:
                spans.append([ii, first, last])
    return spans


def fmt(items, spans):
    return ' '.join(f"{items[ii]['id']}:{a}-{b}" for ii, a, b in spans)


def span_key(items, spans):
    return keyify(''.join(utf16_slice(items[ii]['str'], a, b) for ii, a, b in spans))


def tags_of(items, spans, width, rec):
    tags = set()
    its = [items[ii] for ii, _, _ in spans]
    if len({i['pageIndex'] for i in its}) > 1:
        tags.add('page_boundary')
    for a, b in zip(its, its[1:]):
        if a['pageIndex'] != b['pageIndex']:
            continue
        dy = b['transform'][5] - a['transform'][5]
        dx = b['transform'][4] - a['transform'][4]
        if dy > 40 and dx > width / 4:
            tags.add('column_boundary')
        if not a['hasEOL'] and 0.5 < abs(dy) < 6:
            tags.add('script')
    raw = ''.join(utf16_slice(items[ii]['str'], a, b) for ii, a, b in spans)
    if MATH.search(raw):
        tags.add('inline_math')
    if 'http' in raw:
        tags.add('url')
    if rec['occurrences'] > 1:
        tags.add('repeated')
    if rec['gaps']:
        tags.add('gapped')
    if rec['keyLength'] < 20:
        tags.add('short')
    for (ii, _, b), nxt in zip(spans, spans[1:]):
        s = items[ii]['str'].rstrip()
        if s.endswith('-') and b >= utf16_len(s) - 1 and nxt[0] != ii:
            tags.add('hyphenated')
    return tags


def draft_paper(dump):
    items = sorted(dump['items'], key=lambda x: (x['pageIndex'], x['index']))
    sents = dump['sentences']
    hay, owner = build_stream(items)
    keys = [keyify(s['enRaw']) for s in sents]
    occ = [find_all(hay, k) if k else [] for k in keys]
    anchor = {
        i: (o[0], o[0] + len(keys[i]))
        for i, o in enumerate(occ)
        if len(o) == 1 and len(keys[i]) >= 20
    }
    orders = sorted(anchor)

    def bounds(i):
        j = bisect_right(orders, i - 1) - 1
        prev_end = anchor[orders[j]][1] if j >= 0 else None
        k = bisect_right(orders, i)
        next_start = anchor[orders[k]][0] if k < len(orders) else None
        return prev_end, next_start

    recs = []
    for i, s in enumerate(sents):
        k = keys[i]
        rec = {
            'order': s['order'],
            'kind': s['kind'],
            'enRaw': s['enRaw'],
            'keyLength': len(k),
            'occurrences': len(occ[i]),
            'how': None,
            'segments': [],
            'gaps': [],
        }
        if not k:
            pass
        elif i in anchor:
            rec['how'] = 'unique'
            rec['segments'] = [list(anchor[i])]
        elif occ[i]:
            pe, ns = bounds(i)
            inside = (
                [p for p in occ[i] if p >= pe and p + len(k) <= ns]
                if pe is not None and ns is not None and pe <= ns
                else []
            )
            if len(inside) == 1:
                rec['how'] = 'unique_short' if len(occ[i]) == 1 else 'repeated_by_order'
                rec['segments'] = [[inside[0], inside[0] + len(k)]]
        else:
            segs, rest, lo, hi, ok, first = [], k, 0, len(hay), True, True
            while rest:
                n, pos = longest_prefix(hay, rest, lo, hi)
                if n < min(MIN_SEG, len(rest)) or not pos:
                    ok = False
                    break
                if first and len(pos) > 1:
                    pe, _ = bounds(i)
                    if pe is not None:
                        pos = [p for p in pos if p >= pe and p - pe < WINDOW] or pos
                if first and len(pos) != 1:
                    ok = False
                    break
                p = pos[0]
                segs.append([p, p + n])
                rest = rest[n:]
                lo, hi = p + n, min(len(hay), p + n + WINDOW)
                first = False
                if len(segs) > 5:
                    ok = False
                    break
            if ok:
                rec['how'] = 'segmented'
                rec['segments'] = segs
                for a, b in zip(segs, segs[1:]):
                    gi = sorted({owner[x][0] for x in range(a[1], b[0])})
                    rec['gaps'].append(
                        {
                            'keyLength': b[0] - a[1],
                            'text': ' | '.join(items[x]['str'] for x in gi)[:200],
                        }
                    )
        if rec['segments']:
            rec['spans'] = spans_of_segments(owner, rec['segments'])
        recs.append(rec)
    return items, recs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    review = '--review' in sys.argv
    if not args:
        print(__doc__)
        sys.exit(2)
    dump_dir = args[0]
    manifest = json.load(open(os.path.join(ROOT, 'fixtures/papers.json'), encoding='utf-8'))
    notes = json.load(open(os.path.join(HERE, 'annotations.json'), encoding='utf-8'))
    # 실제로 읽은 문장 목록. 확인 표시는 규칙으로 다시 계산하지 않고 이 목록에서만 준다.
    read_lists = json.load(open(os.path.join(HERE, 'checked.json'), encoding='utf-8'))['orders']
    total_checked = 0
    for paper in manifest['papers']:
        pid = paper['id']
        dump = json.load(open(os.path.join(dump_dir, f'{pid}.dump.json'), encoding='utf-8'))
        items, recs = draft_paper(dump)
        pos_of = {it['id']: i for i, it in enumerate(items)}
        width = dump['pages'][0]['width']
        ann = notes.get(pid, {})

        for rec in recs:
            a = ann.get(str(rec['order']), {})
            rec['tags'] = set(a.get('tags', []))
            rec['note'] = a.get('note')
            rec['optional'] = a.get('optional')
            if 'ranges' in a:
                if rec['how'] is not None:
                    sys.exit(f"{pid} #{rec['order']}: 자동 초안이 있는데 ranges가 지정됨")
                rec['how'] = 'manual'
                rec['spans'] = spans_of_ranges(items, pos_of, a['ranges'])
                same = span_key(items, rec['spans']) == keyify(rec['enRaw'])
                if same == bool(a.get('textDiffers')):
                    sys.exit(f"{pid} #{rec['order']}: 수동 범위의 글이 문장 글과 {'같다' if same else '다르다'}")
            elif rec['how'] is not None and span_key(items, rec['spans']) != keyify(rec['enRaw']):
                sys.exit(f"{pid} #{rec['order']}: 초안 스팬의 글이 문장 글과 다르다")
            if rec['how'] is not None:
                rec['tags'] |= tags_of(items, rec['spans'], width, rec)

        resolved = [r for r in recs if r['how'] is not None]
        hard = [r for r in resolved if r['how'] == 'manual' or r['tags'] & HARD]
        read_orders = set(read_lists.get(pid, []))
        if review:
            # 검수 제안: 어려운 사례 전부 + 일정 간격의 평범한 문장. 이미 읽은 문장은 다시 내지 않는다.
            chosen = {r['order'] for r in hard}
            plain = [r for r in resolved if r['order'] not in chosen | read_orders]
            need = max(0, CHECKED_PER_PAPER - len(chosen | read_orders))
            if need and plain:
                step = len(plain) / need
                for n in range(need):
                    chosen.add(plain[min(len(plain) - 1, int(n * step))]['order'])
            chosen -= read_orders
        else:
            chosen = read_orders
            unread = [r['order'] for r in hard if r['order'] not in read_orders]
            if unread:
                print(f'{pid}: 읽지 않은 어려운 사례 {unread} (auto로 남는다)')

        entries = []
        for r in resolved:
            checked = r['order'] in chosen
            verification = 'manual' if r['how'] == 'manual' else ('read' if checked else 'auto')
            e = {
                'order': r['order'],
                'textSha': hashlib.sha256(r['enRaw'].encode('utf-8')).hexdigest()[:16],
                'head': r['enRaw'][:48],
                'verification': verification,
                'how': r['how'],
                'tags': sorted(r['tags']),
                'spans': fmt(items, r['spans']),
            }
            if r['optional']:
                e['optional'] = r['optional']
            if r['note']:
                e['note'] = r['note']
            entries.append(e)
        checked_n = sum(1 for e in entries if e['verification'] != 'auto')
        total_checked += checked_n

        if review:
            print(f'===== {pid} 확인 대상 {checked_n}건')
            for r in resolved:
                if r['order'] not in chosen:
                    continue
                sp = r['spans']
                before = items[sp[0][0] - 1]['str'][-40:] if sp[0][0] > 0 else ''
                head_item = items[sp[0][0]]['str']
                tail_item = items[sp[-1][0]]['str']
                print(f"#{r['order']} {r['how']} occ={r['occurrences']} {sorted(r['tags'])}")
                print(f"  문장: {r['enRaw'][:150]}")
                print(
                    '  스팬: '
                    + ' ¦ '.join(utf16_slice(items[ii]['str'], a, b) for ii, a, b in sp)[:150]
                )
                print(
                    f"  앞글: …{before!r} + {utf16_slice(head_item, 0, sp[0][1])[-40:]!r}"
                    f"  뒷글: {utf16_slice(tail_item, sp[-1][2], utf16_len(tail_item))[:40]!r}"
                )
                print(f"  끝  : 문장 …{r['enRaw'][-50:]!r}  스팬 …{utf16_slice(tail_item, sp[-1][1], sp[-1][2])[-50:]!r}")
                for g in r['gaps']:
                    print(f"  틈  : {g['keyLength']}자 {g['text'][:140]!r}")
                if r['note']:
                    print(f"  메모: {r['note']}")
            unresolved = [r for r in recs if r['how'] is None]
            for r in unresolved:
                print(f"#{r['order']} 미해결: {r['enRaw'][:120]}")
            continue

        out = {
            'schemaVersion': 1,
            'paper': {
                'id': pid,
                'arxivVersion': paper['arxivVersion'],
                'sha256': paper['sha256'],
                'pages': paper['pages'],
            },
            'source': {
                'pdfjsVersion': dump['pdfjsVersion'],
                'items': len(items),
                'itemsDigest': dump['itemsDigest'],
            },
            'parser': {
                'name': 'grobid',
                'version': '0.9.1',
                'teiSha256': dump['teiSha256'],
                'sentences': len(recs),
            },
            'method': METHOD,
            'limits': LIMITS,
            'entries': entries,
        }
        path = os.path.join(ROOT, 'fixtures/truth', f'mapping.{pid}.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write('\n')
        c = Counter(e['verification'] for e in entries)
        t = Counter(tag for e in entries if e['verification'] != 'auto' for tag in e['tags'])
        print(
            f"{pid}: 문장 {len(recs)} 정답 {len(entries)} 미해결 {len(recs) - len(resolved)} "
            f"{dict(c)} 확인 대상 태그 {dict(t)}"
        )
    if not review:
        print(f'확인 대상 합계 {total_checked}')


main()
