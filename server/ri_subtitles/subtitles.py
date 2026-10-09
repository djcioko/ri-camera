"""Word-timed, Unicode-safe captions shared by the native export formats."""
import html
import math
import re


def clean_text(text, preserve_lines=False):
    if not isinstance(text, str):
        return ''
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    if preserve_lines:
        return '\n'.join(filter(None, (' '.join(line.split()) for line in text.splitlines())))
    return ' '.join(text.split())


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def append_text(left, right):
    if not left:
        return right
    gap = '' if re.match(r'^[,.!?;:%)\]…]', right) or re.search(r'[(\[«„“]$', left) else ' '
    return left + gap + right


def wrap_lines(text):
    lines, current = [], ''
    for word in clean_text(text).split():
        combined = append_text(current, word)
        if current and len(combined) > 42:
            lines.append(current)
            current = word
        else:
            current = combined
    if current:
        lines.append(current)
    return lines


def readable_text(text):
    lines = wrap_lines(text)
    if len(lines) == 2:
        words = ' '.join(lines).split()
        best = abs(len(lines[0]) - len(lines[1]))
        for index in range(1, len(words)):
            pair = [' '.join(words[:index]), ' '.join(words[index:])]
            gap = abs(len(pair[0]) - len(pair[1]))
            if max(map(len, pair)) <= 42 and gap < best:
                lines, best = pair, gap
    return '\n'.join(lines)


def normalize_words(words, duration):
    """Use actual ASR word intervals; never divide a sentence proportionally."""
    if not finite(duration) or duration <= 0:
        return []
    valid = []
    for word in words:
        start, end, text = word.get('start'), word.get('end'), clean_text(word.get('text'))
        if not finite(start) or not finite(end) or end < start or (start < 0 and end <= 0) or start >= duration or not text:
            continue
        valid.append({'start': max(0., start), 'end': min(duration, end), 'text': text})
    valid.sort(key=lambda word: word['start'])
    grouped = []
    for word in valid:
        if grouped and grouped[-1]['start'] == word['start']:
            grouped[-1]['text'] = append_text(grouped[-1]['text'], word['text'])
            grouped[-1]['end'] = max(grouped[-1]['end'], word['end'])
        else:
            grouped.append(word.copy())
    cues, current = [], None
    for index, word in enumerate(grouped):
        next_start = grouped[index + 1]['start'] if index + 1 < len(grouped) else duration
        end = min(next_start, word['end'] if word['end'] > word['start'] else next_start)
        if end <= word['start']:
            continue
        combined = append_text(current['text'], word['text']) if current else word['text']
        if current and (re.search(r'[.!?…]["\'”»)\]]*$', current['text']) or
                        word['start'] - current['end'] > .75 or end - current['start'] > 6 or
                        len(wrap_lines(combined)) > 2):
            current['text'] = readable_text(current['text'])
            cues.append(current)
            current = None
        if current:
            current.update(end=end, text=combined)
        else:
            current = {'start': word['start'], 'end': end, 'text': word['text']}
    if current:
        current['text'] = readable_text(current['text'])
        cues.append(current)
    return cues


def serializable(cues, scale):
    result = []
    for cue in cues:
        start, end = cue.get('start'), cue.get('end')
        text = clean_text(cue.get('text'), True)
        if not finite(start) or not finite(end) or start < 0 or end <= start or not text:
            continue
        # Match JavaScript's positive-time round and carry through integer ticks.
        start, end = math.floor(start * scale + .5), math.floor(end * scale + .5)
        if end > start:
            result.append({'start': start, 'end': end, 'text': text})
    result.sort(key=lambda cue: cue['start'])
    for index, cue in enumerate(result):
        if index + 1 < len(result):
            cue['end'] = min(cue['end'], result[index + 1]['start'])
    return [cue for cue in result if cue['end'] > cue['start']]


def timestamp(ticks, scale, separator, hour_digits=2):
    seconds, fraction = divmod(ticks, scale)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f'{hours:0{hour_digits}d}:{minutes:02d}:{seconds:02d}{separator}{fraction:0{3 if scale == 1000 else 2}d}'


def to_srt(cues):
    blocks = [f"{index}\n{timestamp(cue['start'], 1000, ',')} --> {timestamp(cue['end'], 1000, ',')}\n{html.escape(cue['text'], quote=False)}"
              for index, cue in enumerate(serializable(cues, 1000), 1)]
    return '\n\n'.join(blocks) + '\n' if blocks else ''


def line_width(text):
    width = 0
    for letter in text:
        if letter.isspace():
            width += .36
        elif letter in "ilI.,:;!'|`":
            width += .4
        elif letter in 'MWmw@%':
            width += 1.1
        elif letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZĂÂÎȘȚŞŢ':
            width += .9
        elif letter in 'abcdefghijklmnopqrstuvwxyz0123456789ăâîșțşţ':
            width += .75
        else:
            width += 1.3
    return width


def to_ass(cues, width=1280, height=720):
    valid = serializable(cues, 100)
    margin_x = round(width * .05)
    margin_v = min(round(height * .25), max(44, round(height * .12)))
    longest = max([1] + [line_width(line) for cue in valid for line in cue['text'].splitlines()])
    max_lines = max([2] + [len(cue['text'].splitlines()) for cue in valid])
    font_size = math.floor(min(height * .052, width * .055, (width - 2 * margin_x) / (longest + .14),
                               (height - margin_v) / (max_lines * 1.5)) * 100) / 100
    outline = max(.01, min(3, round(font_size * .065, 2)))
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,{font_size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,{outline},0,2,{margin_x},{margin_x},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    events = []
    for cue in valid:
        text = cue['text'].replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\n', '\\N')
        events.append(f"Dialogue: 0,{timestamp(cue['start'], 100, '.', 1)},{timestamp(cue['end'], 100, '.', 1)},Default,,0,0,0,,{text}")
    return header + '\n'.join(events) + '\n'
