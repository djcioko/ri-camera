"""Native regression for video/audio/subtitles beyond the five-minute point.

Only recognition is injected: container probing, full-length audio extraction,
subtitle rendering, MP4 export and the worker's complete decode remain real.
"""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

from ri_subtitles.worker import probe_media, process_job


FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')


class LongVideoTests(unittest.TestCase):
    def test_six_minute_streamed_webm_preserves_audio_and_subtitles_after_five_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source = job / 'source.media'
            # Small frames and a low frame rate keep this a fast test while both
            # real tracks cover the full six-minute timeline.
            subprocess.run([
                'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=blue:s=320x240:r=1:d=360', '-f', 'lavfi', '-i',
                'sine=frequency=440:sample_rate=16000:duration=360',
                '-c:v', 'libvpx-vp9', '-threads', '1', '-c:a', 'libopus',
                '-live', '1', '-f', 'webm', str(source),
            ], check=True, capture_output=True, timeout=30)
            header = subprocess.run([
                'ffprobe', '-v', 'error', '-show_format', '-of', 'json', str(source),
            ], check=True, capture_output=True, timeout=10)
            self.assertNotIn('duration', json.loads(header.stdout)['format'])
            self.assertAlmostEqual(probe_media(source).duration, 360, delta=.1)

            recognized = []

            def recognize(audio, progress):
                with wave.open(str(audio)) as wav:
                    self.assertEqual(wav.getframerate(), 16000)
                    self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 360, delta=.1)
                    wav.setpos(355 * wav.getframerate())
                    self.assertNotEqual(set(wav.readframes(16000)), {0})
                recognized.append(True)
                return [{'start': 355, 'end': 358, 'text': 'Și după cinci minute.'}]

            result = process_job(job, job / 'unused-model', FONT,
                                 recognizer=recognize, job_timeout=60)
            self.assertEqual(recognized, [True])
            self.assertEqual(result['status'], 'ready')
            self.assertAlmostEqual(result['duration'], 360, delta=.1)
            self.assertEqual(result['cues'][0]['start'], 355)
            srt = (job / 'subtitles.srt').read_text(encoding='utf-8')
            self.assertIn('00:05:55,000 --> 00:05:58,000', srt)
            self.assertIn('Și după cinci minute.', srt)
            output = probe_media(job / 'output.mp4')
            self.assertEqual((output.video_codec, output.audio_codec), ('h264', 'aac'))
            # A subtitle after minute five is present in the rendered picture.
            frame = subprocess.run([
                'ffmpeg', '-nostdin', '-v', 'error', '-ss', '356', '-i', str(job / 'output.mp4'),
                '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
            ], check=True, capture_output=True, timeout=10).stdout
            white = sum(1 for index in range(0, len(frame), 3)
                        if min(frame[index:index + 3]) > 150)
            self.assertGreater(white, 10)


if __name__ == '__main__':
    unittest.main()
