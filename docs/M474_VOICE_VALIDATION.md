# M47.4 — Tamil / Tanglish VOICE VALIDATION READINESS

`docs/M474_VOICE_VALIDATION.md`

**Status record (kept honest):**

| Language | Status | Basis |
| --- | --- | --- |
| English | **TESTED — working in the documented environment** | M47.1/M47.2 evidence: real transcription runs with usable output; no native-speaker WER study exists yet. |
| Tamil | **UNVERIFIED** | M47.1 evidence: provider returned unusable output for Tamil in the tested configuration. No native-speaker validation performed. **No change of status is justified by M47.4.** |
| Tanglish (Tamil written in Latin script, code-mixed with English) | **UNVERIFIED** | No provider guarantee; no native-speaker validation performed. |

M47.4 delivers the validation PACK below so the owner can commission real native-speaker testing.
It does NOT claim provider language support, does not substitute providers, and did not perform
native-speaker tests (none were available in this environment — recorded as the outstanding work).

---

## 1. Test categories and representative scripts

Each category uses ONE representative prompt (≤ 20 s speech) recorded in a controlled environment.
Native speakers should record the EXACT script; any improvisation must be noted in the record.

### EN — English (baseline)
- **EN-1 clear narration**: "Cut the intro to four seconds, keep the logo shot, and fade the music under the closing card."
- **EN-2 editing vocabulary**: "Add a cross dissolve between clip two and three, punch in on the product, and duck the background audio by six decibels."
- **EN-3 numbers and punctuation**: "Chapter one: twelve seconds. Chapter two: forty five seconds. End card at one minute, ten seconds."

### TA — Tamil
- **TA-1 clear narration** (formal Tamil): "காணொளியின் தொடக்கத்தை நான்கு வினாடிகளாக சுருக்கவும், முடிவில் வரும் அட்டையை மெதுவாக மறைக்கவும்." (Trim the video's opening to four seconds; slowly fade the closing card.)
- **TA-2 editing vocabulary + numbers**: "இரண்டாவது காட்சியை முப்பது வினாடிகளாக வெட்டு, பின்னணி ஒலியை குறை." (Cut the second scene to thirty seconds; lower the background audio.)
- **TA-3 names and regional pronunciation**: "சென்னை காட்சியை முதலில் வை, கோவை காட்சியை கடைசியில் வை." (Put the Chennai scene first; the Coimbatore scene last.)

### TGL — Tanglish (Tamil in Latin script, code-mixed)
- **TGL-1 code-mixed editing instruction**: "Intro ah trim pannu, logo shot ah keep pannu, ending la music fade pannu."
- **TGL-2 mixed numbers**: "Second clip la 30 seconds cut pannu, background audio ah konjam lower pannu."
- **TGL-3 conversational**: "Konjam fast pannu aisle transitions, last la super slow motion shot keep pannu."

### MIX — mixed-language single utterance
- **MIX-1**: "Opening la Chennai skyline, then 'Supe­r day' text animation, finally fade to logo." (English + Tamil word + English)

### Noise robustness (each language, one variant)
- Same script recorded at SNR ≈ 10 dB with café/road ambience added at −20 dBFS.

## 2. Expected transcripts and evaluation rubric

- **Primary metric: Word Error Rate (WER)** = (S + D + I) / N, computed per category and overall,
  where S/D/I are substitutions/deletions/insertions against the expected transcript and N is the
  reference word count. For Tanglish, tokenization is BY WHITESPACE on the Latin-script reference
  (record the tokenizer choice in every run — WER is only comparable under the same tokenization).
- **Case/punctuation normalization**: lowercase, strip punctuation before comparison (record the
  normalization; also report a raw score for punctuation-accuracy interest).
- **Per-category pass thresholds (proposed, owner-tunable)**: EN ≤ 10% WER; TA ≤ 15%; TGL ≤ 20%;
  MIX ≤ 20%; noise variants ≤ threshold + 5 percentage points. Editing-command tokens
  ("trim", "fade", "pannu", numbers) must survive verbatim — a mangled editing token is a FAIL for
  the utterance even if WER is under threshold (an editing assistant lives or dies on command words).
- **Additional qualitative flags** (record yes/no per utterance): code-switch boundary preserved,
  numbers transcribed as digits vs words correctly, proper nouns (Chennai, Coimbatore) correct.

## 3. Speaker and reviewer requirements

- **Speakers**: ≥ 2 native Tamil speakers (self-declared and reviewer-verified fluency), one of
  whom regularly writes Tanglish; ≥ 1 native English speaker as the control. Different genders and
  at least two regional accents (e.g. Chennai, Coimbatore/Madurai) for TA.
- **Reviewers**: a native Tamil speaker independent of the recording speaker, who verifies the
  expected transcript matches the recording BEFORE scoring and adjudicates disagreements.
- **Consent**: every speaker signs a recorded-consent form covering (a) recording of their voice,
  (b) sending audio to the transcription PROVIDER for testing, (c) retention of results. Keep the
  consent records with the results. Test audio must be SYNTHETIC-SCRIPT content only — no private
  media of real persons is uploaded (M47.4 engineering rules).
- **Provider configuration record** (per run): provider name, model identifier, language hint
  (explicit vs auto), audio format/sample rate, request date, raw provider response, and the exact
  post-processing applied.

## 4. Record format (one JSON per utterance)

```json
{
  "case_id": "TA-2",
  "language": "ta",
  "category": "editing-vocabulary-numbers",
  "provider": "<provider>",
  "model": "<model-id>",
  "languageHint": "auto|ta|en",
  "audioFormat": "wav/16kHz/mono",
  "testDate": "YYYY-MM-DD",
  "speakerId": "<anonymous speaker code>",
  "noiseCondition": "clean|10dB-cafe",
  "expectedTranscript": "<exact script>",
  "actualTranscript": "<provider output verbatim>",
  "normalization": "lowercase, punctuation stripped, whitespace tokenized",
  "S": 0, "D": 0, "I": 0, "N": 12, "wer": 0.0,
  "editingTokensIntact": true,
  "reviewerId": "<anonymous reviewer code>",
  "notes": "<free text>"
}
```

Aggregate: a run is LANGUAGE-VERIFIED only when ALL its utterances meet the per-category threshold
AND the editing-token rule, across ≥ 2 speakers, with reviewer sign-off recorded.

## 5. Outstanding work (explicit)

1. Recruit qualified speakers + reviewer, obtain consents. (Not available in this environment.)
2. Record the TA/TGL/MIX fixtures and run the CURRENT provider with the recorded configuration.
3. Compute WER per the rubric; publish results in this file's results section (to be added).
4. Only after a genuine pass: change the product's language status from UNVERIFIED.
5. If the provider keeps failing Tamil (per M47.1), record that as a PROVIDER limitation and surface
   the provider decision to the owner — do not silently switch providers.
