import json
import hashlib
from dataclasses import replace
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import wave

from ri_subtitles.worker import (MediaError, MODEL_FILES, MODEL_REPO, MODEL_REVISION, MODEL_SIZE,
                                MODEL_SHA256, probe_media, process_job, read_audio_samples, run_command, verify_model)

FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def fixture(self, name='source.media', audio=True, offset=0, width=160, height=120):
        output = self.root / name
        args = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                f'color=c=blue:s={width}x{height}:r=10:d=3']
        if audio:
            args += ['-itsoffset', str(offset), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2']
        args += ['-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p']
        if audio:
            args += ['-c:a', 'aac']
        args += ['-f', 'mp4', str(output)]
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return output

    def test_probe_rejects_invalid_media_without_leaking_path(self):
        source = self.root / 'source.media'
        source.write_text('#EXTM3U\nhttps://example.invalid/video.ts\n')
        with self.assertRaises(MediaError) as raised:
            probe_media(source)
        self.assertNotIn(str(self.root), str(raised.exception))

    def test_probe_rejects_duration_and_pixel_limits(self):
        source = self.fixture()
        with self.assertRaises(MediaError):
            probe_media(source, max_duration=1)
        with self.assertRaises(MediaError):
            probe_media(source, max_pixels=100)
        with self.assertRaises(MediaError):
            probe_media(source, max_input_bytes=100)

    def test_output_dimensions_are_even_and_long_edge_is_bounded(self):
        self.fixture(audio=False, width=3200, height=100)
        result = process_job(self.root, self.root / 'model', FONT, recognizer=lambda a, p: [])
        self.assertEqual((result['width'], result['height']), (1920, 60))

    def test_final_cues_are_clipped_to_validated_output_duration(self):
        self.fixture()
        real_probe = probe_media
        def probe_with_frame_rounding(path, **kwargs):
            metadata = real_probe(path, **kwargs)
            return replace(metadata, duration=2.95) if Path(path).name == 'output.partial.mp4' else metadata
        # Model output/header frame rounding is an external dependency. All decoding
        # and rendering remains real; only its final duration boundary is injected.
        with patch('ri_subtitles.worker.probe_media', side_effect=probe_with_frame_rounding):
            result = process_job(self.root, self.root / 'model', FONT,
                                 recognizer=lambda a, p: [{'start': 2.8, 'end': 3., 'text': 'Bună'}])
        self.assertLessEqual(result['cues'][-1]['end'], result['duration'])
        self.assertIn('00:00:02,950', (self.root / 'subtitles.srt').read_text())

    def test_native_output_and_real_audio_offset(self):
        self.fixture(offset=1, width=640, height=480)
        def recognize(audio, progress):
            with wave.open(str(audio)) as wav:
                self.assertEqual(wav.getframerate(), 16000)
                self.assertEqual(wav.getnchannels(), 1)
                frames = wav.readframes(12000)
                self.assertEqual(set(frames), {0})
            progress(.5)
            return [{'start': 1.1, 'end': 2.7, 'text': 'Șță îâ, România!'}]
        result = process_job(self.root, self.root / 'model', FONT, recognizer=recognize)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['cues'][0]['start'], 1.1)
        self.assertEqual(json.loads((self.root / 'result.json').read_text()), result)
        self.assertEqual(result['outputBytes'], (self.root / 'output.mp4').stat().st_size)
        meta = probe_media(self.root / 'output.mp4')
        self.assertTrue(meta.has_audio)
        self.assertEqual((meta.width, meta.height), (640, 480))
        self.assertIn('Șță îâ', (self.root / 'subtitles.srt').read_text())
        # A white subtitle must appear in the lower picture; the source is plain blue.
        frame = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '1.5', '-i', str(self.root / 'output.mp4'),
                                '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
        white = sum(1 for index in range(0, len(frame), 3) if min(frame[index:index + 3]) > 150)
        self.assertGreater(white, 10)
        self.assertFalse((self.root / 'audio.wav').exists())

    def test_rotated_video_has_portrait_output_and_no_rotation(self):
        original = self.fixture(name='original.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-display_rotation:v:0', '90', '-i', str(original), '-c', 'copy',
                        '-f', 'mp4', str(self.root / 'source.media')], check=True, capture_output=True)
        meta = probe_media(self.root / 'source.media')
        self.assertEqual((meta.display_width, meta.display_height), (120, 160))
        result = process_job(self.root, self.root / 'model', FONT, recognizer=lambda a, p: [])
        self.assertEqual((result['width'], result['height']), (120, 160))
        output = probe_media(self.root / 'output.mp4')
        self.assertEqual(output.rotation, 0)
        self.assertEqual(result['status'], 'empty')

    def test_hevc_and_webm_inputs_export_native_mp4(self):
        original = self.fixture(name='original.mp4')
        variants = [('hevc', ['-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1', '-c:a', 'aac', '-f', 'mp4']),
                    ('webm', ['-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'webm'])]
        for name, codecs in variants:
            with self.subTest(format=name):
                job = self.root / name
                job.mkdir()
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(original)] + codecs +
                               [str(job / 'source.media')], check=True, capture_output=True)
                result = process_job(job, self.root / 'model', FONT, recognizer=lambda a, p: [])
                output = probe_media(job / 'output.mp4')
                self.assertEqual(output.video_codec, 'h264')
                self.assertEqual(output.audio_codec, 'aac')
                self.assertEqual(result['status'], 'empty')

    def test_streamed_webm_derives_real_duration_and_keeps_audio_offset(self):
        original = self.fixture(name='original.mp4', offset=1)
        source = self.root / 'source.media'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(original),
                        '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-live', '1', '-f', 'webm', str(source)],
                       check=True, capture_output=True)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', str(source)],
                               check=True, capture_output=True)
        self.assertNotIn('duration', json.loads(probe.stdout)['format'])
        metadata = probe_media(source)
        self.assertTrue(2.9 <= metadata.duration <= 3.1)
        with self.assertRaises(MediaError) as raised:
            probe_media(source, max_duration=1)
        self.assertEqual(raised.exception.code, 'duration_limit')
        def recognize(audio, progress):
            with wave.open(str(audio)) as wav:
                self.assertEqual(set(wav.readframes(12000)), {0})
            return [{'start': 1.1, 'end': 2.7, 'text': 'Și mâine!'}]
        result = process_job(self.root, self.root / 'model', FONT, recognizer=recognize)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['cues'][0]['start'], 1.1)
        self.assertFalse((self.root / 'duration-scan.mkv').exists())

    def test_full_range_camera_video_exports_limited_range_yuv420p(self):
        original = self.fixture(name='original.mp4', audio=False)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(original),
                        '-vf', 'scale=in_range=tv:out_range=pc', '-color_range', 'pc', '-c:v', 'libvpx-vp9',
                        '-live', '1', '-f', 'webm', str(self.root / 'source.media')], check=True, capture_output=True)
        result = process_job(self.root, self.root / 'model', FONT)
        self.assertEqual(result['status'], 'empty')
        self.assertEqual(probe_media(self.root / 'output.mp4').pixel_format, 'yuv420p')

    def test_streamed_webm_over_fifteen_minutes_is_rejected_without_truncation(self):
        source = self.root / 'source.media'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x120:r=1:d=2',
                        '-vf', 'setpts=PTS*901', '-fps_mode', 'passthrough', '-c:v', 'libvpx-vp9', '-threads', '1',
                        '-live', '1', '-f', 'webm', str(source)], check=True, capture_output=True)
        with self.assertRaises(MediaError) as raised:
            probe_media(source)
        self.assertEqual(raised.exception.code, 'duration_limit')
        self.assertFalse((self.root / 'duration-scan.mkv').exists())

    def test_streamed_webm_negative_audio_priming_and_late_video_keep_shared_origin(self):
        source = self.root / 'source.media'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-itsoffset', '0.5', '-f', 'lavfi', '-i',
                        'color=s=160x120:r=10:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3',
                        '-c:v', 'libvpx-vp9', '-threads', '1', '-c:a', 'libopus', '-avoid_negative_ts', 'disabled',
                        '-live', '1', '-f', 'webm', str(source)], check=True, capture_output=True)
        def recognize(audio, progress):
            with wave.open(str(audio)) as wav:
                self.assertNotEqual(set(wav.readframes(1600)), {0})
            return [{'start': .1, 'end': 2.7, 'text': 'Bună!'}]
        result = process_job(self.root, self.root / 'model', FONT, recognizer=recognize)
        output = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(self.root / 'output.mp4')],
                                check=True, capture_output=True)
        streams = json.loads(output.stdout)['streams']
        video = next(stream for stream in streams if stream['codec_type'] == 'video')
        audio = next(stream for stream in streams if stream['codec_type'] == 'audio')
        self.assertGreater(float(video['start_time']), float(audio['start_time']) + .35)
        self.assertLess(abs(float(audio['start_time'])), .05)
        self.assertEqual(result['cues'][0]['start'], .1)

    def test_silent_video_skips_recognizer(self):
        self.fixture(audio=False)
        def unexpected(a, p):
            self.fail('Silence must not call ASR')
        result = process_job(self.root, self.root / 'model', FONT, recognizer=unexpected)
        self.assertEqual(result['status'], 'empty')
        self.assertEqual((self.root / 'subtitles.srt').read_text(), '')

    def test_pcm_samples_are_normalized_float32_without_file_decoder(self):
        import struct
        audio = self.root / 'samples.wav'
        with wave.open(str(audio), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(struct.pack('<hhhh', -32768, -16384, 0, 16384))
        samples = read_audio_samples(audio)
        self.assertEqual(str(samples.dtype), 'float32')
        self.assertEqual(samples.tolist(), [-1., -.5, 0., .5])

    def test_deadline_and_output_guards_kill_process(self):
        with self.assertRaises(MediaError) as raised:
            run_command(['python3', '-c', 'import time; time.sleep(5)'], time.monotonic() + .1)
        self.assertEqual(raised.exception.code, 'processing_timeout')
        with self.assertRaises(MediaError):
            run_command(['python3', '-c', 'print("x" * 100000)'], time.monotonic() + 5, max_capture=100)
        output = self.root / 'too-large'
        with self.assertRaises(MediaError) as raised:
            run_command(['python3', '-c', 'from pathlib import Path; Path("too-large").write_bytes(b"x"*10000)'],
                        time.monotonic() + 5, cwd=self.root, guarded_files=(output,), max_file_bytes=100)
        self.assertEqual(raised.exception.code, 'output_limit')

    def test_model_requires_verified_all_five_files(self):
        model = self.root / 'model'
        model.mkdir()
        (model / 'model.bin').write_bytes(b'not the model')
        with self.assertRaises(MediaError):
            verify_model(model)

    def test_readiness_checks_all_sizes_and_pinned_identity_without_large_hash(self):
        model = self.root / 'model'
        model.mkdir()
        entries = {}
        for name in MODEL_FILES:
            path = model / name
            if name == 'model.bin':
                with path.open('wb') as handle:
                    handle.truncate(MODEL_SIZE)
                entries[name] = {'size': MODEL_SIZE, 'sha256': MODEL_SHA256}
            else:
                path.write_bytes(b'{}')
                entries[name] = {'size': 2, 'sha256': hashlib.sha256(b'{}').hexdigest()}
        manifest = {'repoId': MODEL_REPO, 'revision': MODEL_REVISION, 'files': entries}
        (model / 'model-manifest.json').write_text(json.dumps(manifest))
        verify_model(model, full=False)
        (model / 'tokenizer.json').write_bytes(b'wrong-size')
        with self.assertRaises(MediaError):
            verify_model(model, full=False)
        (model / 'tokenizer.json').write_bytes(b'{}')
        manifest['revision'] = 'untrusted'
        (model / 'model-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(MediaError):
            verify_model(model, full=False)

    def test_worker_cli_writes_safe_failure_and_exits_nonzero(self):
        (self.root / 'source.media').write_text('invalid')
        command = ['python3', '-m', 'ri_subtitles.worker', '--job-dir', str(self.root), '--model-dir',
                   str(self.root / 'model'), '--font-path', str(FONT)]
        process = subprocess.run(command, capture_output=True)
        self.assertNotEqual(process.returncode, 0)
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(process.stdout, b'')


if __name__ == '__main__':
    unittest.main()
