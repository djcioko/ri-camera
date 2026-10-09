const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const subtitles = require("../subtitle-utils.js");

test("word timestamps become a readable Romanian caption without changing the input", () => {
  const chunks = [
    { text: " Bună", timestamp: [0, 0.3] },
    { text: " ziua,", timestamp: [0.3, 0.6] },
    { text: " astăzi", timestamp: [0.6, 1] },
    { text: " lucrăm", timestamp: [1, 1.4] },
    { text: " pe", timestamp: [1.4, 1.6] },
    { text: " șantier.", timestamp: [1.6, 2.1] },
  ];
  const original = structuredClone(chunks);

  assert.deepEqual(subtitles.normalizeCues(chunks, 3), [
    { start: 0, end: 2.1, text: "Bună ziua, astăzi lucrăm pe șantier." },
  ]);
  assert.deepEqual(chunks, original);
});

test("timestamps are sorted, clipped, inferred and made non-overlapping", () => {
  const cues = subtitles.normalizeCues([
    { text: "Începem.", timestamp: [5, null] },
    { text: "Salut.", timestamp: [-2, 1.5] },
    { text: "Mai departe.", timestamp: [2, 10] },
    { text: "Lipsă început.", timestamp: [null, 2] },
    { text: "   ", timestamp: [1.5, 2] },
    { text: "Final.", timestamp: [8, 14] },
    { text: "Interval invers.", timestamp: [7, 6] },
    { text: "După înregistrare.", timestamp: [20, 21] },
    { text: "NaN.", timestamp: [NaN, 2] },
    { text: 123, timestamp: [1, 2] },
  ], 10);

  assert.deepEqual(cues, [
    { start: 0, end: 1.5, text: "Salut." },
    { start: 2, end: 5, text: "Mai departe." },
    { start: 5, end: 8, text: "Începem." },
    { start: 8, end: 10, text: "Final." },
  ]);
});

test("absent speech and unusable timing never create a transcript", () => {
  for (const chunks of [undefined, null, {}, [], [{ text: " ", timestamp: [0, 1] }]]) {
    assert.deepEqual(subtitles.normalizeCues(chunks, 4), []);
  }
  for (const duration of [undefined, null, 0, -1, NaN, Infinity, "4"]) {
    assert.deepEqual(subtitles.normalizeCues([{ text: "Salut.", timestamp: [0, 1] }], duration), []);
  }
  assert.deepEqual(subtitles.normalizeCues([
    { text: "Lipsă.", timestamp: [undefined, 1] },
    { text: "Infinit.", timestamp: [Infinity, 1] },
    { text: "Interval invers.", timestamp: [1, 0.9] },
    { text: "Final.", timestamp: [1.25, null] },
  ], 2), [{ start: 1.25, end: 2, text: "Final." }]);
});

test("word grouping attaches punctuation and respects pauses and sentence boundaries", () => {
  const cues = subtitles.normalizeCues([
    { text: "Bună", timestamp: [0, 0.3] },
    { text: ",", timestamp: [0.3, 0.4] },
    { text: "România", timestamp: [0.4, 0.8] },
    { text: "!", timestamp: [0.8, 1] },
    { text: "Continuăm", timestamp: [1, 1.4] },
    { text: "mâine", timestamp: [3, 3.4] },
  ], 4);

  assert.deepEqual(cues, [
    { start: 0, end: 1, text: "Bună, România!" },
    { start: 1, end: 1.4, text: "Continuăm" },
    { start: 3, end: 3.4, text: "mâine" },
  ]);
});

test("equal starts keep their transcript while overlapping intervals are shortened", () => {
  assert.deepEqual(subtitles.normalizeCues([
    { text: "Bună", timestamp: [0, 0.4] },
    { text: "ziua.", timestamp: [0, 0.8] },
    { text: "Continuăm.", timestamp: [0.5, 1] },
  ], 2), [
    { start: 0, end: 0.5, text: "Bună ziua." },
    { start: 0.5, end: 1, text: "Continuăm." },
  ]);
});

test("zero-duration Whisper words remain in readable positive-duration captions", () => {
  const chunks = [
    { text: "Înainte.", timestamp: [-2, -2] },
    { text: "Tot înainte.", timestamp: [-1, 0] },
    { text: "Bună", timestamp: [0, 0] },
    { text: "ziua,", timestamp: [0, 0.5] },
    { text: "suntem", timestamp: [0.5, 0.9] },
    { text: "pe", timestamp: [0.9, 0.9] },
    { text: "șantier.", timestamp: [1.1, 1.5] },
    { text: "Interval invers.", timestamp: [1.6, 1.4] },
    { text: "Gata.", timestamp: [1.8, 1.8] },
    { text: "După.", timestamp: [2, 2] },
    { text: "Și după.", timestamp: [3, 3] },
  ];
  const original = structuredClone(chunks);
  const cues = subtitles.normalizeCues(chunks, 2);

  assert.deepEqual(cues, [
    { start: 0, end: 1.5, text: "Bună ziua, suntem pe șantier." },
    { start: 1.8, end: 2, text: "Gata." },
  ]);
  assert.deepEqual(chunks, original);
  assert.equal(subtitles.toSrt(cues), "1\n00:00:00,000 --> 00:00:01,500\nBună ziua, suntem pe șantier.\n\n2\n00:00:01,800 --> 00:00:02,000\nGata.\n");
});

test("long segments split into short two-line cues inside their original interval", () => {
  const text = "Astăzi verificăm lucrările de pe șantier și pregătim materialele pentru următoarea etapă. Echipa montează structura cu atenție, măsoară fiecare element și verifică toate detaliile înainte de finalizare.";
  const cues = subtitles.normalizeCues([{ text, timestamp: [2, 12] }], 15);

  assert.ok(cues.length >= 3);
  assert.equal(cues[0].start, 2);
  assert.equal(cues.at(-1).end, 12);
  assert.equal(cues.map((cue) => cue.text).join(" ").replace(/\s+/g, " "), text);
  for (const [index, cue] of cues.entries()) {
    assert.ok(cue.end > cue.start);
    assert.ok(cue.start >= 2 && cue.end <= 12);
    assert.ok(cue.text.split("\n").length <= 2);
    assert.ok(cue.text.split("\n").every((line) => Array.from(line).length <= 42));
    if (index) assert.ok(cue.start >= cues[index - 1].end);
  }
});

test("continuous word output has bounded reading lengths and caption durations", () => {
  const chunks = Array.from({ length: 40 }, (_, index) => ({
    text: index === 39 ? "lucrăm." : "lucrăm",
    timestamp: [index * 0.3, (index + 1) * 0.3],
  }));
  const cues = subtitles.normalizeCues(chunks, 12);

  assert.ok(cues.length > 1);
  assert.equal(cues.map((cue) => cue.text).join(" ").replace(/\s+/g, " "), chunks.map((chunk) => chunk.text).join(" "));
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 6);
    assert.ok(cue.text.split("\n").length <= 2);
    assert.ok(cue.text.split("\n").every((line) => line.length <= 42));
  }
});

test("SRT keeps diacritics and carries millisecond rounding into minutes and hours", () => {
  assert.equal(subtitles.toSrt([
    { start: 59.9996, end: 60.5004, text: "Începem lucrările." },
    { start: 3599.9996, end: 3601.2, text: "Șantier pregătit.\nMâine continuăm." },
  ]), "1\n00:01:00,000 --> 00:01:00,500\nÎncepem lucrările.\n\n2\n01:00:00,000 --> 01:00:01,200\nȘantier pregătit.\nMâine continuăm.\n");
  assert.equal(subtitles.toSrt([]), "");
});

test("WebVTT has a valid header and timestamps for native video text tracks", () => {
  assert.equal(subtitles.toVtt([
    { start: 0, end: 1.0017, text: "Țară, șantier și echipă." },
  ]), "WEBVTT\n\n00:00:00.000 --> 00:00:01.002\nȚară, șantier și echipă.\n");
  assert.equal(subtitles.toVtt([]), "WEBVTT\n\n");
});

test("SRT and WebVTT escape markup and cannot inject extra cue delimiters", () => {
  const cue = { start: 0, end: 2, text: "Șantier <b>test</b> &\r\n\r\n00:00:09.000 --> 00:00:10.000\n<script>alert(1)</script>\u0000" };
  const safeText = "Șantier &lt;b&gt;test&lt;/b&gt; &amp;\n00:00:09.000 --&gt; 00:00:10.000\n&lt;script&gt;alert(1)&lt;/script&gt;";
  assert.equal(subtitles.toSrt([cue]), `1\n00:00:00,000 --> 00:00:02,000\n${safeText}\n`);
  assert.equal(subtitles.toVtt([cue]), `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${safeText}\n`);
});

test("serializers omit invalid and rounding-collapsed intervals", () => {
  const cues = [
    { start: NaN, end: 1, text: "Invalid." },
    { start: 0, end: Infinity, text: "Infinit." },
    { start: 1, end: 0, text: "Invers." },
    { start: 0, end: 1, text: "   " },
    { start: 0.00001, end: 0.00002, text: "Prea scurt." },
    { start: 2, end: 3, text: "Corect." },
  ];
  assert.equal(subtitles.toSrt(cues), "1\n00:00:02,000 --> 00:00:03,000\nCorect.\n");
  assert.equal(subtitles.toVtt(cues), "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nCorect.\n");
  assert.equal(subtitles.toAss(cues).split("\n").filter((line) => line.startsWith("Dialogue: ")).length, 1);
});

function assStyle(ass) {
  const styles = ass.split("[V4+ Styles]\n")[1].split("[Events]")[0].trim().split("\n");
  const fields = styles.find((line) => line.startsWith("Format: ")).slice(8).split(",").map((part) => part.trim());
  const values = styles.find((line) => line.startsWith("Style: ")).slice(7).split(",");
  return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
}

test("ASS places outlined white DejaVu Sans captions above the bottom date in either orientation", () => {
  for (const [width, height] of [[1280, 720], [720, 1280], [320, 240]]) {
    const ass = subtitles.toAss([{ start: 0, end: 2, text: "Lucrări pe șantier.\nEchipa este pregătită." }], { width, height });
    const style = assStyle(ass);

    assert.ok(ass.includes(`PlayResX: ${width}\nPlayResY: ${height}\n`));
    assert.equal(style.Fontname, "DejaVu Sans");
    assert.equal(style.PrimaryColour, "&H00FFFFFF");
    assert.equal(style.OutlineColour, "&H00101010");
    assert.equal(style.Alignment, "2");
    assert.equal(style.BorderStyle, "1");
    assert.ok(Number(style.Outline) > 0);
    assert.ok(Number(style.MarginV) >= height * 0.1);
    assert.ok(Number(style.MarginV) <= height * 0.25);
    assert.ok(Number(style.MarginL) > 0 && Number(style.MarginR) > 0);
    assert.ok(Number(style.Fontsize) * 3 + Number(style.MarginV) < height);
    assert.ok(ass.includes("Lucrări pe șantier.\\NEchipa este pregătită."));
  }
});

test("ASS centisecond rounding carries correctly and defaults invalid dimensions", () => {
  const ass = subtitles.toAss([{ start: 59.999, end: 60.501, text: "Gata." }], { width: NaN, height: -1 });
  assert.ok(ass.includes("PlayResX: 1280\nPlayResY: 720\n"));
  assert.ok(ass.includes("Dialogue: 0,0:01:00.00,0:01:00.50,Default,,0,0,0,,Gata.\n"));
});

test("ASS text cannot move subtitles or create event rows", () => {
  const ass = subtitles.toAss([{ start: 0, end: 2, text: "Salut {\\pos(0,0)}\\N\nȘantier\r\nDialogue: 9,test" }]);
  const rows = ass.split("\n").filter((line) => line.startsWith("Dialogue: "));

  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes("｛＼pos(0,0)｝＼N"));
  assert.ok(rows[0].includes("Șantier"));
  assert.ok(!rows[0].includes("{\\pos"));
  assert.ok(!rows[0].includes("\r"));
});

test("the same utility API loads as a plain browser script", () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../subtitle-utils.js"), "utf8"), browser);

  assert.deepEqual(Object.keys(browser.RISubtitleUtils).sort(), ["normalizeCues", "toAss", "toSrt", "toVtt"]);
  assert.equal(browser.RISubtitleUtils.toVtt([{ start: 0, end: 1, text: "Bună." }]), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nBună.\n");
});
