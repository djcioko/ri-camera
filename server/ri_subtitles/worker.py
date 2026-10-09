"""Offline Romanian ASR and native media worker; no API/database dependency.

The supervisor launches this module in a fresh process group. All native children
inherit that group, so terminating a job also terminates its FFmpeg processes.
"""
import argparse
from array import array
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time
import wave

from .subtitles import finite, normalize_words, to_ass, to_srt

MODEL_REPO = 'dropbox-dash/faster-whisper-large-v3-turbo'
MODEL_REVISION = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
MODEL_SIZE = 1617884929
MODEL_SHA256 = 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da'
MODEL_FILES = ('config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json')
DEFAULT_MAX_INPUT = 512 * 1024 * 1024
DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024 * 1024


class MediaError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check_deadline(deadline):
    if time.monotonic() >= deadline:
        raise MediaError('processing_timeout', 'Procesarea a depășit timpul permis.')


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def run_command(args, deadline, *, max_capture=2 * 1024 * 1024, guarded_files=(), max_file_bytes=DEFAULT_MAX_OUTPUT, cwd=None):
    """Bound both captured diagnostic bytes and disk output; never silently truncate."""
    check_deadline(deadline)
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               cwd=cwd, close_fds=True)
    selector = selectors.DefaultSelector()
    captured = {process.stdout: bytearray(), process.stderr: bytearray()}
    for pipe in captured:
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ)
    total = 0
    try:
        while selector.get_map():
            check_deadline(deadline)
            if sum(path.stat().st_size for path in guarded_files if path.exists()) > max_file_bytes:
                raise MediaError('output_limit', 'Rezultatul depășește spațiul permis.')
            for key, _ in selector.select(.1):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                total += len(block)
                if total > max_capture:
                    raise MediaError('invalid_media', 'Fișierul nu poate fi procesat în limitele permise.')
                captured[key.fileobj].extend(block)
        process.wait(timeout=max(.01, deadline - time.monotonic()))
        if sum(path.stat().st_size for path in guarded_files if path.exists()) > max_file_bytes:
            raise MediaError('output_limit', 'Rezultatul depășește spațiul permis.')
        if process.returncode:
            # Diagnostics can contain uploaded text and private paths: do not expose/log them.
            raise MediaError('invalid_media', 'Fișierul video nu poate fi decodat sau exportat.')
        return bytes(captured[process.stdout])
    except subprocess.TimeoutExpired:
        raise MediaError('processing_timeout', 'Procesarea a depășit timpul permis.') from None
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        selector.close()
        process.stdout.close()
        process.stderr.close()


@dataclass(frozen=True)
class Media:
    duration: float
    width: int
    height: int
    display_width: int
    display_height: int
    rotation: int
    has_audio: bool
    video_index: int
    audio_index: int | None
    video_codec: str
    audio_codec: str | None
    pixel_format: str | None
    format_name: str


def number(value):
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise MediaError('invalid_media', 'Metadatele video sunt invalide.') from None
    if not math.isfinite(result):
        raise MediaError('invalid_media', 'Metadatele video sunt invalide.')
    return result


def derive_media_duration(path, video_index, audio_index, deadline, max_input_bytes):
    """Read existing packet timestamps through a bounded, lossless native remux.

    Streamed WebM/MediaRecorder omit the duration element. Matroska's finalized
    seekable header derives it from the actual packets, using the same shared
    timeline normalization as extraction/export. No frames or timestamps are
    synthesized and no duration/file truncation flags are permitted here.
    """
    temporary = path.parent / 'duration-scan.mkv'
    if path.resolve() == temporary.resolve():
        raise MediaError('invalid_media', 'Metadatele video sunt incomplete.')
    try:
        args = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-max_alloc', '268435456',
                '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
                '-copyts', '-start_at_zero', '-i', str(path), '-map', f'0:{video_index}']
        if audio_index is not None:
            args += ['-map', f'0:{audio_index}']
        args += ['-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1',
                 '-avoid_negative_ts', 'disabled', '-f', 'matroska', str(temporary)]
        run_command(args, deadline, guarded_files=(temporary,), max_file_bytes=max_input_bytes + 64 * 1024 * 1024)
        raw = run_command(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                           '-format_whitelist', 'matroska,webm', '-show_entries', 'format=duration',
                           '-of', 'json', str(temporary)], deadline)
        return number(json.loads(raw).get('format', {}).get('duration'))
    finally:
        temporary.unlink(missing_ok=True)


def probe_media(path, *, max_duration=900, max_pixels=16777216, max_input_bytes=DEFAULT_MAX_INPUT, deadline=None):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= max_input_bytes:
        raise MediaError('input_limit', 'Fișierul video lipsește sau depășește limita permisă.')
    deadline = deadline or time.monotonic() + 30
    raw = run_command(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-max_alloc', '268435456',
                       '-probesize', '10000000', '-analyzeduration', '10000000', '-show_format', '-show_streams',
                       '-print_format', 'json', str(path)], deadline)
    try:
        data = json.loads(raw)
        fmt, streams = data['format'], data['streams']
        names = set(fmt['format_name'].split(','))
        if not names or not names <= {'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'}:
            raise MediaError('unsupported_format', 'Folosește un fișier MOV, MP4, MKV sau WebM.')
        if len(streams) > 32:
            raise MediaError('invalid_media', 'Fișierul conține prea multe piste.')
        videos = [s for s in streams if s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic')]
        audios = [s for s in streams if s.get('codec_type') == 'audio']
        if not videos:
            raise MediaError('invalid_media', 'Fișierul nu conține o pistă video.')
        video, audio = videos[0], audios[0] if audios else None
        # A missing duration is normal in streamed/MediaRecorder WebM. An
        # explicitly malformed or nonfinite duration is still rejected.
        duration = number(fmt['duration']) if 'duration' in fmt else None
        # All available durations/start times must be finite, including ignored tracks.
        for stream in streams:
            for key in ('duration', 'start_time'):
                if key in stream:
                    value = number(stream[key])
                    if key == 'duration' and (value < 0 or value > max_duration + 1):
                        raise MediaError('duration_limit', 'Durata depășește limita permisă.')
                    if key == 'start_time' and abs(value) > max_duration:
                        raise MediaError('invalid_media', 'Axa temporală video este invalidă.')
        if 'start_time' in fmt and abs(number(fmt['start_time'])) > max_duration:
            raise MediaError('invalid_media', 'Axa temporală video este invalidă.')
        if duration is not None and not 0 < duration <= max_duration:
            raise MediaError('duration_limit', 'Durata depășește limita permisă.')
        width, height = int(video['width']), int(video['height'])
        if width < 2 or height < 2 or width * height > max_pixels:
            raise MediaError('pixel_limit', 'Rezoluția video depășește limita permisă.')
        rotation = number(video.get('tags', {}).get('rotate', 0))
        for side in video.get('side_data_list', []):
            if 'rotation' in side:
                rotation = number(side['rotation'])
        if abs(rotation / 90 - round(rotation / 90)) > .01:
            raise MediaError('invalid_media', 'Rotația video nu este acceptată.')
        rotation = round(rotation) % 360
        sar = video.get('sample_aspect_ratio', '1:1')
        if sar in ('N/A', '0:1'):
            sar = '1:1'
        numerator, denominator = sar.split(':')
        ratio = number(numerator) / number(denominator)
        if not .1 <= ratio <= 10:
            raise MediaError('invalid_media', 'Raportul pixelilor video nu este acceptat.')
        display_width, display_height = round(width * ratio), height
        if rotation in (90, 270):
            display_width, display_height = display_height, display_width
        if display_width < 2 or display_height < 2 or display_width * display_height > max_pixels:
            raise MediaError('pixel_limit', 'Rezoluția afișată depășește limita permisă.')
        if duration is None:
            duration = derive_media_duration(path, int(video['index']), int(audio['index']) if audio else None,
                                             deadline, max_input_bytes)
            if not 0 < duration <= max_duration:
                raise MediaError('duration_limit', 'Durata depășește limita permisă.')
        return Media(duration, width, height, display_width, display_height, rotation, bool(audio), int(video['index']),
                     int(audio['index']) if audio else None, video['codec_name'], audio.get('codec_name') if audio else None,
                     video.get('pix_fmt'), fmt['format_name'])
    except (KeyError, TypeError, ValueError, ZeroDivisionError, json.JSONDecodeError):
        raise MediaError('invalid_media', 'Metadatele video sunt incomplete sau invalide.') from None


def sha256_file(path, deadline=None):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while block := handle.read(4 * 1024 * 1024):
            if deadline:
                check_deadline(deadline)
            digest.update(block)
    return digest.hexdigest()


def verify_model(model_dir, deadline=None, *, full=True):
    """Recheck every local file against the installer manifest before loading offline."""
    model_dir = Path(model_dir)
    try:
        manifest = json.loads((model_dir / 'model-manifest.json').read_text())
        if manifest['repoId'] != MODEL_REPO or manifest['revision'] != MODEL_REVISION or set(manifest['files']) != set(MODEL_FILES):
            raise ValueError('manifest')
        for name in MODEL_FILES:
            path = model_dir / name
            entry = manifest['files'][name]
            if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['size'] or entry['size'] <= 0:
                raise ValueError('size')
            if not isinstance(entry['sha256'], str) or len(entry['sha256']) != 64:
                raise ValueError('checksum')
            if full and sha256_file(path, deadline) != entry['sha256']:
                raise ValueError('checksum')
            if name != 'model.bin':
                json.loads(path.read_text(encoding='utf-8'))
        if manifest['files']['model.bin'] != {'size': MODEL_SIZE, 'sha256': MODEL_SHA256}:
            raise ValueError('model')
    except (OSError, ValueError, KeyError, TypeError):
        raise MediaError('model_unavailable', 'Modelul vocal local nu este pregătit.') from None


def speech_present(audio_path):
    """Conservative PCM silence guard: prevent Whisper text on zero/near-zero audio."""
    with wave.open(str(audio_path), 'rb') as wav:
        if wav.getsampwidth() != 2 or wav.getframerate() != 16000 or wav.getnchannels() != 1:
            raise MediaError('invalid_media', 'Pista audio normalizată este invalidă.')
        while data := wav.readframes(16000):
            samples = array('h', data)
            if sys.byteorder != 'little':
                samples.byteswap()
            if samples and max(map(abs, samples)) >= 32 and sum(s * s for s in samples) / len(samples) >= 9:
                return True
    return False


def read_audio_samples(audio):
    """Use our native normalized PCM directly; do not decode it again with PyAV."""
    import numpy as np
    with wave.open(str(audio), 'rb') as wav:
        if wav.getsampwidth() != 2 or wav.getframerate() != 16000 or wav.getnchannels() != 1:
            raise MediaError('invalid_media', 'Pista audio normalizată este invalidă.')
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768.


def recognize_audio(audio, model_dir, cpu_threads, duration, progress, deadline):
    verify_model(model_dir, deadline)
    check_deadline(deadline)
    # Disable ONNX telemetry before faster-whisper imports ONNX Runtime, also
    # when this worker is run directly outside its isolated systemd service.
    os.environ['ORT_DISABLE_TELEMETRY'] = '1'
    from faster_whisper import WhisperModel
    model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=cpu_threads,
                         num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(read_audio_samples(audio), language='ro', task='transcribe', beam_size=5,
                                   word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
    words = []
    for segment in segments:
        check_deadline(deadline)
        if segment.no_speech_prob > .6 and segment.avg_logprob < -1:
            continue
        for word in segment.words or []:
            words.append({'start': word.start, 'end': word.end, 'text': word.word})
        progress(min(1., max(0., segment.end / duration)))
    return words


def process_job(job_dir, model_dir, font_path, *, cpu_threads=2, max_duration=900, max_pixels=16777216,
                max_input_bytes=DEFAULT_MAX_INPUT, max_output_bytes=DEFAULT_MAX_OUTPUT, job_timeout=3600, recognizer=None):
    """Run the full media pipeline; injected recognizers use the same timed-word contract."""
    job_dir = Path(job_dir).resolve()
    font_path = Path(font_path).resolve()
    deadline = time.monotonic() + job_timeout
    audio = job_dir / 'audio.wav'
    partial = job_dir / 'output.partial.mp4'
    ass = job_dir / 'subtitles.ass'
    srt_partial = job_dir / 'subtitles.srt.tmp'
    private_font = job_dir / 'fonts'
    def progress(status, value, message):
        atomic_json(job_dir / 'progress.json', {'status': status, 'progress': value, 'message': message})
    try:
        progress('transcribing', 0., 'Verificăm fișierul video.')
        media = probe_media(job_dir / 'source.media', max_duration=max_duration, max_pixels=max_pixels,
                            max_input_bytes=max_input_bytes, deadline=min(deadline, time.monotonic() + 30))
        if not 1 <= cpu_threads <= 2:
            raise MediaError('configuration_error', 'Configurația procesorului este invalidă.')
        ffmpeg = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-max_alloc', '268435456',
                  '-threads', str(cpu_threads), '-filter_threads', str(cpu_threads), '-protocol_whitelist', 'file,pipe',
                  '-format_whitelist', 'mov,matroska,webm',
                  '-copyts', '-start_at_zero', '-i', 'source.media']
        words = []
        if media.has_audio:
            run_command(ffmpeg + ['-map', f'0:{media.audio_index}', '-vn', '-af', 'aresample=async=1:first_pts=0',
                                 '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', str(media.duration), 'audio.wav'],
                        deadline, cwd=job_dir, guarded_files=(audio,), max_file_bytes=64 * 1024 * 1024)
            if speech_present(audio):
                update = lambda value: progress('transcribing', min(1., max(0., float(value))), 'Transcriem vorbirea în română.')
                words = (recognizer(audio, update) if recognizer else
                         recognize_audio(audio, model_dir, cpu_threads, media.duration, update, deadline))
        cues = normalize_words(words, media.duration)
        check_deadline(deadline)
        scale = min(1., 1920 / max(media.display_width, media.display_height))
        width = max(2, int(media.display_width * scale / 2) * 2)
        height = max(2, int(media.display_height * scale / 2) * 2)
        srt_partial.write_text(to_srt(cues), encoding='utf-8')
        # Chrome/canvas recordings may use full-range VP9. Explicitly normalize
        # range, otherwise x264 can label nominal yuv420p as yuvj420p on export.
        filters = f'scale={width}:{height}:in_range=auto:out_range=tv,setsar=1'
        if cues:
            if not font_path.is_file():
                raise MediaError('font_unavailable', 'Fontul pentru subtitrări nu este disponibil.')
            private_font.mkdir(mode=0o700, exist_ok=True)
            shutil.copyfile(font_path, private_font / 'DejaVuSans.ttf')
            ass.write_text(to_ass(cues, width, height), encoding='utf-8')
            filters += ',ass=filename=subtitles.ass:fontsdir=fonts'
        progress('rendering', 0., 'Exportăm MP4 cu sunetul original.')
        args = ffmpeg + ['-map', f'0:{media.video_index}']
        if media.has_audio:
            args += ['-map', f'0:{media.audio_index}', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '160k']
        args += ['-vf', filters, '-c:v', 'libx264', '-threads', str(cpu_threads), '-preset', 'veryfast', '-crf', '22',
                 '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-map_metadata', '-1', '-map_chapters', '-1', '-metadata:s:v:0', 'rotate=0',
                 '-t', str(media.duration), '-movflags', '+faststart', 'output.partial.mp4']
        run_command(args, deadline, cwd=job_dir, guarded_files=(partial,), max_file_bytes=max_output_bytes)
        progress('rendering', .95, 'Verificăm rezultatul MP4.')
        output = probe_media(partial, max_duration=max_duration + 1, max_pixels=max_pixels,
                             max_input_bytes=max_output_bytes, deadline=min(deadline, time.monotonic() + 30))
        if (output.video_codec != 'h264' or output.pixel_format != 'yuv420p' or output.rotation != 0 or
                (output.width, output.height) != (width, height) or output.has_audio != media.has_audio or
                (output.has_audio and output.audio_codec != 'aac') or abs(output.duration - media.duration) > 1.):
            raise MediaError('invalid_output', 'Rezultatul exportat nu a trecut verificarea.')
        # Encoder frame/sample rounding can make the final file slightly shorter
        # than the source. Snapshot and SRT intervals must remain inside that file.
        cues = [{'start': cue['start'], 'end': min(cue['end'], output.duration), 'text': cue['text']}
                for cue in cues if cue['start'] < output.duration]
        srt_partial.write_text(to_srt(cues), encoding='utf-8')
        # Decode the complete export too: valid headers alone cannot prove a complete file.
        run_command(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-threads', str(cpu_threads), '-i', 'output.partial.mp4',
                     '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], deadline, cwd=job_dir)
        os.replace(partial, job_dir / 'output.mp4')
        os.replace(srt_partial, job_dir / 'subtitles.srt')
        result = {'status': 'ready' if cues else 'empty', 'duration': output.duration, 'width': width, 'height': height,
                  'cues': cues, 'outputBytes': (job_dir / 'output.mp4').stat().st_size}
        atomic_json(job_dir / 'result.json', result)
        progress(result['status'], 1., 'Rezultatul este pregătit.' if cues else 'Nu am detectat vorbire.')
        return result
    finally:
        for path in (audio, partial, ass, srt_partial):
            path.unlink(missing_ok=True)
        if private_font.exists():
            shutil.rmtree(private_font)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-dir', required=True, type=Path)
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--font-path', required=True, type=Path)
    parser.add_argument('--cpu-threads', type=int, default=2)
    parser.add_argument('--max-duration', type=float, default=900)
    parser.add_argument('--max-pixels', type=int, default=16777216)
    parser.add_argument('--job-timeout', type=float, default=3600)
    parser.add_argument('--max-input-bytes', type=int, default=DEFAULT_MAX_INPUT)
    parser.add_argument('--max-output-bytes', type=int, default=DEFAULT_MAX_OUTPUT)
    args = parser.parse_args()
    try:
        process_job(**vars(args))
        return 0
    except Exception as error:
        public = error if isinstance(error, MediaError) else MediaError('processing_failed', 'Procesarea video nu a putut fi terminată.')
        result = {'status': 'failed', 'error': {'code': public.code, 'message': str(public)}}
        atomic_json(args.job_dir / 'result.json', result)
        atomic_json(args.job_dir / 'progress.json', {'status': 'failed', 'progress': 0., 'message': str(public)})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
