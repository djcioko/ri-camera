import unittest
from ri_subtitles.subtitles import normalize_words, to_srt, to_ass


class SubtitleTests(unittest.TestCase):
    def test_words_keep_actual_times_and_split_silence_and_sentences(self):
        cues = normalize_words([
            {'start': .2, 'end': .6, 'text': ' Bună'},
            {'start': .6, 'end': 1.1, 'text': ' țară!'},
            {'start': 2, 'end': 2.2, 'text': 'Și'},
            {'start': 2.2, 'end': 2.5, 'text': ' mâine.'}], 3)
        self.assertEqual(cues, [{'start': .2, 'end': 1.1, 'text': 'Bună țară!'},
                                {'start': 2., 'end': 2.5, 'text': 'Și mâine.'}])

    def test_bad_times_and_blank_text_do_not_become_cues(self):
        self.assertEqual(normalize_words([
            {'start': float('nan'), 'end': 1, 'text': 'bad'},
            {'start': 2, 'end': 1, 'text': 'bad'},
            {'start': -1, 'end': -.2, 'text': 'bad'},
            {'start': 2, 'end': 4, 'text': '\x00 '},
            {'start': 5, 'end': 6, 'text': 'bad'}], 4), [])

    def test_overlap_and_zero_duration_are_normalized(self):
        cues = normalize_words([{'start': 0, 'end': 0, 'text': 'A'},
                                {'start': 0, 'end': .2, 'text': ','},
                                {'start': .3, 'end': 2, 'text': 'B'},
                                {'start': 1, 'end': 3, 'text': 'C'}], 2)
        self.assertEqual(cues[0]['text'], 'A, B C')
        self.assertEqual(cues[0]['end'], 2)

    def test_srt_rounding_carries_and_markup_is_literal(self):
        result = to_srt([{'start': 59.9996, 'end': 61, 'text': 'Șță îâ <b>&\n'}])
        self.assertEqual(result, '1\n00:01:00,000 --> 00:01:01,000\nȘță îâ &lt;b&gt;&amp;\n')

    def test_ass_diacritics_and_override_escaping(self):
        result = to_ass([{'start': .1, 'end': 2, 'text': 'Șță îâ {\\pos(0,0)}\nBună'}], 720, 1280)
        self.assertIn('DejaVu Sans', result)
        self.assertIn('Șță îâ ｛＼pos(0,0)｝\\NBună', result)
        self.assertNotIn('{\\pos', result)
        self.assertIn('PlayResY: 1280', result)

    def test_long_words_fit_ass_frame(self):
        result = to_ass([{'start': 0, 'end': 2, 'text': 'W' * 120}], 320, 568)
        style = next(line for line in result.splitlines() if line.startswith('Style:'))
        font_size = float(style.split(',')[2])
        self.assertLess(font_size, 3)


if __name__ == '__main__':
    unittest.main()
