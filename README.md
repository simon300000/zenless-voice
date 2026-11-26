# Zenless Voice

Zenless Voice is a dataset of voice lines from the popular game [Zenless Zone Zero](https://zenless.hoyoverse.com/).

Hugging Face 🤗  [Zenless-Voice](https://huggingface.co/datasets/simon3000/zenless-voice)

ModelScope [Zenless-Voice](https://modelscope.cn/datasets/simono/zenless-voice)

Per-speaker downloads are grouped by language and ZIP size. Browse every archive in the [ZIP index](https://huggingface.co/datasets/simon3000/zenless-voice/blob/main/speaker-archives/README.md).

<!-- STATS -->
Last update at `2026-09-17`, game version `3.2.0`

`406720` wavs

`78785` without speaker (19%)

`123429` without transcription (30%)

`83509` without inGameFilename (21%)
<!-- STATS_END -->

## Dataset Details

### Dataset Description

The dataset contains voice lines from the game's characters in multiple languages, including Chinese, English, Japanese, and Korean.

The voice lines are spoken by the characters in the game and cover a wide range of topics, including greetings, combat, and story dialogue.

- **Language(s) (NLP):** Chinese, English, Japanese, Korean

## Dataset Creation

### Source Data

The data was obtained by unpacking the [Zenless Zone Zero](https://zenless.hoyoverse.com/) game.

#### Data Collection and Processing

Please refer to [Zenless-Voice](https://github.com/simon300000/zenless-voice) for more information on how the data was processed.

#### Who are the source data producers?

The source data producers are the developers of the game, HoYoverse.

### Annotations

The dataset contains official annotations from the game, including language, speaker name, and transcription.

## Bias, Risks, and Limitations

Annotations are incomplete. Some voice lines are missing speaker names and transcriptions.

Annotations are not guaranteed to be completely accurate.

Speakers and transcriptions may contain markups and placeholders, for example: `(My brother and I still have <color=#FFAF2C>something we need to do</color>, and to achieve that goal, we need to venture deep into the Hollows.)`

### Recommendations

Users should be made aware of the risks, biases and limitations of the dataset.

## Licensing Information

Copyright © COGNOSPHERE. All Rights Reserved.

## Acknowledgements

Special thanks to Escartem for [**AnimeWwise**](https://github.com/Escartem/AnimeWwise) and its `nap.map` data, which helped research and validate Zenless Zone Zero's Wwise source-path naming and filename-hash rules.
