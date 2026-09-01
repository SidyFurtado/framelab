---
name: ai-video-analysis
description: Guidance on using multimodal AI APIs for video and audio understanding, structured cue sheet generation, and token optimization. Provider-agnostic with capability-based routing.
---

# AI Video Analysis for Sound Design

Use this skill when designing prompts, structured schemas, or pipelines that process video and audio for sound design detection.

## 1. Provider-Agnostic Architecture
The platform uses a **Bring Your Own AI (BYOAI)** model. The `Tool: AI Sound Design` declares required capabilities:
- `video-understanding` (native container ingestion or frame-extraction fallback)
- `audio-understanding` (native audio track analysis)
- `structured-output` (strict JSON schema response)

The `AIProviderLayer` routes to whichever adapter the user has connected.

### Provider Capability Matrix (Aug 2026)
| Capability | Gemini | Claude | OpenAI |
| :--- | :--- | :--- | :--- |
| Native Video Ingestion | ✅ File API | ❌ (frame extraction) | ❌ (frame extraction) |
| Native Audio | ✅ | ❌ | Via Whisper |
| Structured JSON | ✅ `response_schema` | ✅ Tool Calling | ✅ `json_schema` |

### Recommended First Candidate
Gemini is the recommended first candidate for `Tool: AI Sound Design` because it is the only provider with native video+audio ingestion. However, all implementation must go through the abstract `AIProviderLayer` adapter.

## 2. Token Efficiency (Gemini Reference Numbers)
When using Gemini's native video ingestion:
- Video Visuals: ~258 tokens per second (at 1 FPS).
- Audio Stream: ~32 tokens per second.
- Total: ~300 tokens per second (~18k tokens/minute).

For Claude/OpenAI frame-extraction fallback, token costs depend on frame count and resolution.

## 3. Structured Cue Sheet Schema
Always request strict JSON output regardless of provider:

```json
{
  "scene_analysis": {
    "genre": "cinematic_tech_review",
    "energy_level": "high",
    "dominant_mood": "modern_futuristic"
  },
  "sound_cues": [
    {
      "timestamp_start_seconds": 1.25,
      "timestamp_peak_seconds": 1.50,
      "timestamp_end_seconds": 2.10,
      "category": "transition_whoosh",
      "sub_type": "air_whip_fast",
      "description": "Fast whip pan from host to laptop screen",
      "intensity": 0.85,
      "recommended_gain_db": -12.0,
      "layer_group": "foreground_action"
    }
  ]
}
```

## 4. High-Precision Hybrid Alignment (Sub-Second Events)
Because standard video analysis samples at 1 FPS (Gemini) or uses discrete frames (Claude/OpenAI), fast events must be augmented:
1. Extract exact clip cut boundaries (EDL / sequence in-out points) from Premiere via UXP DOM.
2. Pass these timestamps inside the text prompt as `Timeline Context Metadata`.
3. Instruct the model to align sound cue peaks with the nearest visual transition or cut point provided in the metadata.

## 5. Reference Documentation
For provider comparison tables and authentication details, refer to [docs/TECHNICAL_BASELINE.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/TECHNICAL_BASELINE.md#5-inteligência-artificial--arquitetura-provider-agnostic-byoai).
