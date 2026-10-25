# 🎙 Voice cloning (consent-gated)

Turn text into speech **in a specific person's voice** — but only with a recorded
consent declaration that a **bot owner approves**, and every clip the bot sends is
**clearly labeled as AI-generated**. Off by default.

## How it is kept safe

- **Owner approval is mandatory.** A request stays `pending` and produces nothing
  until an account in `OWNER_IDS` taps ✅. No ordinary user can self-approve
  (enforced in `src/services/voiceclone/policy.ts` → `canApprove`).
- **Every output is self-labeling.** Each clip is sent with an Arabic + English
  disclaimer that it is AI-generated and a `SYNTHETIC_…` filename. This labeling
  is not optional and cannot be toggled off.
- **Consent is recorded, audio is not.** The database stores only Telegram
  `file_id` references and a SHA-256 of the consent declaration — never the raw
  recordings and never the full consent text. Nothing sensitive lands in git or
  logs.
- **Revocable.** The requester (or any owner) can `/revokevoice <id>` and all
  further generation is blocked immediately.
- **Private only.** Submission happens in a DM with the bot, not in groups.

> ⚠️ You are responsible for using this only with voices whose owners have
> genuinely consented. Do not clone anyone's voice without their explicit
> permission, and never use the output to deceive or impersonate.

## Architecture

The voice model is far too heavy for the Render free tier, so it runs on a
separate **engine** (a free Hugging Face **Gradio** Space, CPU — Docker Spaces
require a paid plan). The bot calls the Space's REST API with a shared secret
passed as a call argument. If the engine is not configured, the feature simply
stays off.

```
Telegram ⇄ bot (Render) ──Gradio REST API (+ secret arg)──▶ Voise engine (HF Gradio Space, CPU)
   POST /gradio_api/call/predict → event_id → GET …/{event_id} → ogg/opus audio (base64)
```

## 1 — Deploy the engine (Hugging Face Gradio Space, ZeroGPU)

The ready-to-deploy engine is in [`voice-engine/`](./voice-engine): `app.py`,
`requirements.txt`, `packages.txt`. On HF's free tier Gradio Spaces run on
**ZeroGPU** (on-demand GPU; CPU-basic now needs PRO). `app.py` uses the `spaces`
GPU decorator and runs on CUDA when a GPU is attached, else CPU — so it also
works on CPU-basic (with PRO) or locally, unchanged.

1. Create a new **Space** → **SDK: Gradio** → template **Blank** → hardware
   **ZeroGPU** (free) → **Public**. (Hugging Face writes a starter `README.md`
   with the right `sdk_version` — keep it.)
2. In the Space **Settings → Variables and secrets → New secret**, add
   **`ENGINE_SECRET`** = a long random string (step 3 — same value on both sides).
3. In the Space **Files** tab, replace `app.py` with ours and add
   `requirements.txt` and `packages.txt` (the latter installs ffmpeg). Commit.
   (Do not pin torch — ZeroGPU provides a CUDA build; `requirements.txt` leaves
   it out on purpose.)
4. Let it build. On startup it **downloads the models (~4 GB) and takes a
   while**; the Space shows "Running" when ready. The first `predict` after a
   cold start also loads the models, so it is slow; later calls are fast (GPU).
   Keep texts short (≤ 400 chars — enforced on both sides). ZeroGPU has a **daily
   free GPU-time quota** (PRO raises it), so this is for light use.
5. Your engine URL is `https://<your-username>-<space-name>.hf.space` (shown on
   the Space page). Check it is up: open `…/gradio_api/config` in a browser.

### ZeroGPU API token

ZeroGPU attributes GPU usage to a Hugging Face account, so API calls from the bot
need a token to be served reliably. Create a **read** token at
<https://huggingface.co/settings/tokens> and set it as `VOICE_ENGINE_HF_TOKEN`
on the bot (below). On CPU-basic/local it is optional.

> **Model licensing:** the voice model `oddadmix/lahgtna-omnivoice-v2` ships with
> **no stated license** ("private use only until its author permits more"). Use it
> for your own private, consented purposes only until its author grants broader
> rights. The wrapper code is Apache-2.0; Whisper is MIT; the Higgs tokenizer is
> under the Boson license.

## 2 — Configure the bot (Render environment variables)

| Variable | Value |
| --- | --- |
| `VOICECLONE_ENABLED` | `true` |
| `VOICE_ENGINE_URL` | `https://<your-username>-<space-name>.hf.space` |
| `VOICE_ENGINE_SECRET` | the **same** secret you set as `ENGINE_SECRET` |
| `VOICE_ENGINE_HF_TOKEN` | a HF **read** token (needed for ZeroGPU quota) |
| `VOICE_ENGINE_LANG` *(optional)* | `apc` (Levantine Arabic; default) |
| `VOICE_ENGINE_TIMEOUT_SEC` *(optional)* | `300` (raise if the Space is slow) |

The table auto-creates on the next deploy (`prisma db push` on boot), so no manual
migration is needed.

## 3 — The shared secret

Generate one long random secret and paste the **same** value into both
`ENGINE_SECRET` (HF Space) and `VOICE_ENGINE_SECRET` (Render). For example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# or: openssl rand -hex 32
```

Keep it out of git and out of chat logs.

## Using it

All in a **private chat** with the bot:

1. `/clonevoice` (or «استنساخ صوت»).
2. Send one or more **voice recordings** of the voice owner, then `/done`.
3. Answer: who the voice owner is, the permitted use, and type a consent
   declaration.
4. The request is sent to the owner(s) for review. Track it with `/myvoices`.
5. An owner taps ✅ (or uses `/voicequeue`).
6. Generate speech: `/speak <id> <text>` → the bot replies with a voice note
   labeled as AI-generated.
7. Revoke any time: `/revokevoice <id>`.

## Code map

| File | Role |
| --- | --- |
| `src/services/voiceclone/policy.ts` | Pure gates: who may approve/generate/revoke, reference & text validation, synthetic labeling, consent hash. |
| `src/services/voiceclone/engine.ts` | Gradio REST client for the engine; serial queue (one job at a time). |
| `src/services/voiceclone/consent.ts` | DB-backed consent records (`VoiceConsent` model). |
| `src/plugins/voiceclone/index.ts` | Telegram wizard, owner approval buttons, generation, revocation. |
| `voice-engine/` | The deployable Hugging Face Space engine. |

Tests: `tests/voiceclone.test.ts`.
