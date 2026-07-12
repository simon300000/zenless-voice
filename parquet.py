import json

from datasets import Audio, Dataset
from huggingface_hub import HfApi

audio_folder = 'result/'
repo_id = 'simon3000/zenless-voice'

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
