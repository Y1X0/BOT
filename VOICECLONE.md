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
separate **engine** (a free Hugging Face Space, CPU). The bot calls it over HTTPS
with a shared secret. If the engine is not configured, the feature simply stays
off.

```
Telegram ⇄ bot (Render)  ──HTTPS + X-Engine-Secret──▶  Voise engine (HF Space, CPU)
                                                        POST /tts → ogg/opus audio
```

## 1 — Deploy the engine (Hugging Face Space)

The ready-to-deploy engine is in [`voice-engine/`](./voice-engine): `app.py`,
`Dockerfile`, `requirements.txt`, `fetch_models.py`, `README.md`.

1. Create a new **Space** → **SDK: Docker** → hardware **CPU basic** (free).
2. Add the five files from `voice-engine/` to the Space (drag-and-drop in the web
   UI, or `git push` to the Space repo). The `README.md` already has the required
   Space header (`sdk: docker`, `app_port: 7860`).
3. In the Space **Settings → Variables and secrets**, add a secret named
   **`ENGINE_SECRET`** set to a long random string (see step 3 below — use the
   same value on both sides).
4. Let it build. The first build **downloads the models and takes a while**; the
   Space shows "Running" when ready. The first `/tts` after a cold start is slow
   (model load); later ones are faster. CPU synthesis is still minutes-scale, so
   keep texts short (≤ 400 chars — enforced on both sides).
5. Your engine URL is `https://<your-username>-<space-name>.hf.space`.

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
| `VOICE_ENGINE_LANG` *(optional)* | `apc` (Levantine Arabic; default) |
| `VOICE_ENGINE_TIMEOUT_SEC` *(optional)* | `180` (raise if the Space is slow) |

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
| `src/services/voiceclone/engine.ts` | HTTPS client for the engine; serial queue (one job at a time, matching the engine's own lock). |
| `src/services/voiceclone/consent.ts` | DB-backed consent records (`VoiceConsent` model). |
| `src/plugins/voiceclone/index.ts` | Telegram wizard, owner approval buttons, generation, revocation. |
| `voice-engine/` | The deployable Hugging Face Space engine. |

Tests: `tests/voiceclone.test.ts`.
