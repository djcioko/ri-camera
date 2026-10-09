(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RISubtitleUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_LINE_CHARS = 42;
  const MAX_CUE_SECONDS = 6;
  const MAX_WORD_GAP = 0.75;

  function cleanText(value, preserveLines = false) {
    if (typeof value !== "string") return "";
    const text = value.replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (!preserveLines) return text.replace(/\s+/g, " ").trim();
    // Empty lines would terminate an SRT/WebVTT cue; keep only actual text lines.
    return text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  }

  function textLength(text) {
    return Array.from(text).length;
  }

  function appendText(left, right) {
    if (!left) return right;
    const separator = /^[,.!?;:%)\]…]/u.test(right) || /[(\[«„“]$/u.test(left) ? "" : " ";
    return left + separator + right;
  }

  function wrapLines(text) {
    const lines = [];
    let line = "";
    for (const word of cleanText(text).split(" ")) {
      if (line && textLength(appendText(line, word)) > MAX_LINE_CHARS) {
        lines.push(line);
        line = word;
      } else {
        line = appendText(line, word);
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function readableText(text) {
    const lines = wrapLines(text);
    if (lines.length !== 2) return lines.join("\n");
    // Balance the final pair without splitting words or altering diacritics.
    const words = lines.join(" ").split(" ");
    let best = lines;
    let difference = Math.abs(textLength(lines[0]) - textLength(lines[1]));
    for (let index = 1; index < words.length; index += 1) {
      const first = words.slice(0, index).join(" ");
      const second = words.slice(index).join(" ");
      const gap = Math.abs(textLength(first) - textLength(second));
      if (textLength(first) <= MAX_LINE_CHARS && textLength(second) <= MAX_LINE_CHARS && gap < difference) {
        best = [first, second];
        difference = gap;
      }
    }
    return best.join("\n");
  }

  function splitSegment(segment) {
    const lines = wrapLines(segment.text);
    const parts = [];
    for (let index = 0; index < lines.length; index += 2) {
      parts.push(readableText(lines.slice(index, index + 2).join(" ")));
    }
    if (parts.length <= 1) return [{ ...segment, text: parts[0] || "" }];
    // Sentence-only timestamps cannot locate individual words. Proportional
    // timing stays inside the supplied interval without inventing a transcript.
    const weights = parts.map((text) => textLength(text));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let consumed = 0;
    return parts.map((text, index) => {
      const start = segment.start + (segment.end - segment.start) * consumed / total;
      consumed += weights[index];
      const end = index === parts.length - 1 ? segment.end : segment.start + (segment.end - segment.start) * consumed / total;
      return { start, end, text };
    }).filter((cue) => cue.end > cue.start && cue.text);
  }

  function normalizeCues(chunks, durationSeconds) {
    if (!Array.isArray(chunks) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
    const segments = chunks.flatMap((chunk) => {
      if (!chunk || !Array.isArray(chunk.timestamp) || !Number.isFinite(chunk.timestamp[0])) return [];
      const text = cleanText(chunk.text);
      const [rawStart, rawEnd] = chunk.timestamp;
      const hasEnd = Number.isFinite(rawEnd);
      if (hasEnd && (rawEnd < rawStart || (rawStart < 0 && rawEnd <= 0))) return [];
      const start = Math.max(0, Math.min(durationSeconds, rawStart));
      const end = hasEnd ? Math.max(0, Math.min(durationSeconds, rawEnd)) : null;
      if (!text || start >= durationSeconds) return [];
      // Whisper sometimes gives a real word identical start/end timestamps.
      // Keep its text for equal-start grouping or infer an end at the next word.
      return [{ start, end: end === start ? null : end, text }];
    }).sort((left, right) => left.start - right.start);

    const distinct = [];
    for (const segment of segments) {
      const previous = distinct[distinct.length - 1];
      if (previous && previous.start === segment.start) {
        previous.text = appendText(previous.text, segment.text);
        previous.end = previous.end === null || segment.end === null ? null : Math.max(previous.end, segment.end);
      } else {
        distinct.push({ ...segment });
      }
    }

    const timed = distinct.flatMap((segment, index) => {
      const nextStart = index + 1 < distinct.length ? distinct[index + 1].start : durationSeconds;
      const end = Math.min(segment.end === null ? nextStart : segment.end, nextStart);
      return end > segment.start ? splitSegment({ ...segment, end }) : [];
    });
    const cues = [];
    let current = null;
    function flush() {
      if (current) cues.push({ ...current, text: readableText(current.text) });
      current = null;
    }
    for (const segment of timed) {
      const text = cleanText(segment.text);
      const combined = current ? appendText(current.text, text) : text;
      const sentenceEnd = current && /[.!?…]["'”»)\]]*$/u.test(current.text);
      if (current && (sentenceEnd || segment.start - current.end > MAX_WORD_GAP ||
        segment.end - current.start > MAX_CUE_SECONDS || wrapLines(combined).length > 2)) flush();
      if (current) {
        current.text = combined;
        current.end = segment.end;
      } else {
        current = { start: segment.start, end: segment.end, text };
      }
    }
    flush();
    return cues;
  }

  function serializableCues(cues, scale) {
    if (!Array.isArray(cues)) return [];
    const valid = cues.flatMap((cue) => {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) return [];
      const start = Math.round(cue.start * scale);
      const end = Math.round(cue.end * scale);
      const text = cleanText(cue.text, true);
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start && text ? [{ start, end, text }] : [];
    }).sort((left, right) => left.start - right.start);
    return valid.flatMap((cue, index) => {
      const end = index + 1 < valid.length ? Math.min(cue.end, valid[index + 1].start) : cue.end;
      return end > cue.start ? [{ ...cue, end }] : [];
    });
  }

  function timestamp(ticks, scale, separator, hourDigits = 2) {
    const seconds = Math.floor(ticks / scale);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const wholeSeconds = seconds % 60;
    const fraction = ticks % scale;
    return `${String(hours).padStart(hourDigits, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${separator}${String(fraction).padStart(scale === 1000 ? 3 : 2, "0")}`;
  }

  function escapeMarkup(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function toSrt(cues) {
    const blocks = serializableCues(cues, 1000).map((cue, index) =>
      `${index + 1}\n${timestamp(cue.start, 1000, ",")} --> ${timestamp(cue.end, 1000, ",")}\n${escapeMarkup(cue.text)}`);
    return blocks.length ? blocks.join("\n\n") + "\n" : "";
  }

  function toVtt(cues) {
    const blocks = serializableCues(cues, 1000).map((cue) =>
      `${timestamp(cue.start, 1000, ".")} --> ${timestamp(cue.end, 1000, ".")}\n${escapeMarkup(cue.text)}`);
    return "WEBVTT\n\n" + (blocks.length ? blocks.join("\n\n") + "\n" : "");
  }

  function assText(text) {
    // ASS does not have reliable literal escapes for braces. Fullwidth glyphs
    // display the supplied punctuation without enabling overrides or \N codes.
    return text.replace(/\\/g, "＼").replace(/{/g, "｛").replace(/}/g, "｝").replace(/\n/g, "\\N");
  }

  function lineWidthUnits(text) {
    // Conservative DejaVu Sans glyph widths in em; this also handles long
    // unsplittable words without letting them run outside portrait video.
    return Array.from(text).reduce((width, letter) => {
      if (/\s/u.test(letter)) return width + 0.36;
      if (/[ilI.,:;!'|`]/u.test(letter)) return width + 0.4;
      if (/[MWmw@%]/u.test(letter)) return width + 1.1;
      if (/[A-ZĂÂÎȘȚŞŢ]/u.test(letter)) return width + 0.9;
      if (/[a-z0-9ăâîșțşţ]/u.test(letter)) return width + 0.75;
      return width + 1.3;
    }, 0);
  }

  function toAss(cues, { width = 1280, height = 720 } = {}) {
    width = Number.isFinite(width) && width >= 1 ? Math.round(width) : 1280;
    height = Number.isFinite(height) && height >= 1 ? Math.round(height) : 720;
    const valid = serializableCues(cues, 100);
    const marginX = Math.round(width * 0.05);
    const marginV = Math.min(Math.round(height * 0.25), Math.max(44, Math.round(height * 0.12)));
    const longestLine = Math.max(1, ...valid.flatMap((cue) => cue.text.split("\n").map(lineWidthUnits)));
    const maxLines = Math.max(2, ...valid.map((cue) => cue.text.split("\n").length));
    const fontSize = Math.floor(Math.min(height * 0.052, width * 0.055,
      (width - 2 * marginX) / (longestLine + 0.14), (height - marginV) / (maxLines * 1.5)) * 100) / 100;
    const outline = Math.max(0.01, Math.min(3, Math.round(fontSize * 0.065 * 100) / 100));
    const header = [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      "WrapStyle: 2",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${marginX},${marginX},${marginV},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "",
    ].join("\n");
    const events = valid.map((cue) =>
      `Dialogue: 0,${timestamp(cue.start, 100, ".", 1)},${timestamp(cue.end, 100, ".", 1)},Default,,0,0,0,,${assText(cue.text)}`);
    return header + (events.length ? events.join("\n") + "\n" : "");
  }
  return { normalizeCues, toSrt, toVtt, toAss };
});
