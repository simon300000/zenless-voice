import argparse
import json
from pathlib import Path

from datasets import Audio, Dataset
from huggingface_hub import HfApi

audio_folder = 'result/'
repo_id = 'simon3000/zenless-voice'

parser = argparse.ArgumentParser()
parser.add_argument('--speaker-archives-dir', type=Path, default=Path(audio_folder) / 'speaker-archives')
parser.add_argument('--speaker-archives-repo-dir', default='speaker-archives')
parser.add_argument('--skip-speaker-archives', action='store_true')
args = parser.parse_args()

HfApi().upload_file(
    path_or_fileobj=audio_folder + 'README.md',
    path_in_repo='README.md',
    repo_id=repo_id,
    repo_type='dataset',
)

HfApi().upload_file(
    path_or_fileobj='result.json',
    path_in_repo='result.json',
    repo_id=repo_id,
    repo_type='dataset',
)

with open(audio_folder + 'metadata.jsonl', encoding='utf-8') as file:
    voices = [json.loads(line) for line in file]

dataset = Dataset.from_dict({
    'audio': [voice['filename'] for voice in voices],
    'ingame_filename': [voice['inGameFilename'] for voice in voices],
    'transcription': [voice['transcription'] for voice in voices],
    'language': [voice['language'] for voice in voices],
    'speaker': [voice['speaker'] for voice in voices],
    'voice_type': [voice['voiceType'] for voice in voices],
}).cast_column('audio', Audio())

dataset.push_to_hub(repo_id, max_shard_size='5GB')

if not args.skip_speaker_archives:
    archives = sorted(args.speaker_archives_dir.rglob('*.zip'))
    if not args.speaker_archives_dir.is_dir():
        raise SystemExit(f'Speaker archive directory does not exist: {args.speaker_archives_dir}')
    if archives:
        print(f'Uploading {len(archives)} speaker archives to {args.speaker_archives_repo_dir}/')
        HfApi().upload_folder(
            folder_path=args.speaker_archives_dir,
            path_in_repo=args.speaker_archives_repo_dir.strip('/'),
            repo_id=repo_id,
            repo_type='dataset',
        )
    else:
        print('No speaker archives to upload')
