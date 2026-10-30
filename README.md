# Show Me the Problem

**A live call that sees.** A homeowner calls a plumbing, HVAC or electrical business and points their phone at what is broken. An agent built on Meta's models:

- outlines the part on the live camera and steers the phone with arrows and voice ("tilt up, closer, hold still") until the view is usable;
- leads a **guided tour** for someone who has never been in the room (boiler room, under a sink, an electrical panel): it names every part on screen with a label on its outline and a status (looks normal, needs attention, safety issue, can't tell from this angle), and keeps a "found in this room" list;
- talks hands-free, and stops talking when the caller starts;
- looks for hazards the caller never mentioned, and only acts when two models agree;
- shows every safety check as **clear** or **found**, with the frame it used;
- forms a worn-part hypothesis that must cite its evidence;
- gives water shut-off steps from a fixed playbook (never gas);
- quotes only from the owner's price list, and books only after the owner taps approve;
- hands the technician a work order where every claim links to its evidence.

Built for the Meta Global AI Developer Hackathon (building period Oct 27 – Nov 4, 2026).

## Why it is not an image analyzer

The camera is a sensor inside an agent that talks, decides, verifies and acts. Muse Spark picks one tool per step (find a part, direct the camera, look at the frame, record a hypothesis, guide a shut-off, read the price list, check the calendar, propose a quote, escalate, request a booking). Code around it measures, gates and draws.

## The Meta models and what each one does

| Model | Job in the call |
|---|---|
| **SAM 3.1** | Segments the named part in the live frame (text prompt), or the object under a point (point prompt). Returns a mask and a confidence. Code decodes the one_bit mask and computes centroid and area for the guidance arrows and the lock. SAM must also outline every camera hazard before it counts. |
| **Muse Spark 1.3** | The agent (function tools, `parallel_tool_calls: false`, at most 6 tool steps per caller turn and 12 turns per call). Also: grounding points (0–1000 grid) when SAM's text prompt misses, a hazard scan of the frame every 10 s, and `inspect_frame` (faucet type, where the water appears). |
| **Muse Voice Transcribe 1.0** | Realtime over `wss://api.meta.ai/v1/asr/realtime` in ENDPOINTING mode (turn detection), English and Spanish. Our server relays 16 kHz PCM and adds the key; the browser never sees it. Push-to-talk WAV is the fallback. |
| **Muse Image 1.0** | After approval, an illustration for the technician, labelled "not evidence". The evidence still is the real frame with the SAM outline drawn in code. |

The agent's voice is the browser's built-in speech synthesis: Meta lists no text-to-speech model.

## How the camera part works

1. **Grounded handoff** (`src/locate.js`). A fresh tap on the screen goes first, as a SAM point prompt. Otherwise SAM gets a plain object noun ("pipe", not "pipe leak"). On a miss, two things run in parallel: SAM with an alternative noun, and a Muse Spark grounding point handed to SAM as a point prompt. The most confident result wins.
2. **Guidance** (`src/guidance.js`, no model call). From the mask's centroid and area: up, down, left, right, closer or back. "Locked" means two analyzed frames in a row agree the part is centred, big enough and steady. Outlines come from the last analyzed frame and fade as they age, so they never pretend to be live.
3. **Light** (in code). The page sends each frame's mean brightness. Two dark frames in a row make the agent say "turn on a light, or use a second phone's flashlight". A **Light** button turns on the phone torch through the camera track (`applyConstraints({advanced:[{torch:true}]})`: Android Chrome, and iPhone Safari from iOS 17.5 per WebKit's bug tracker). Where nothing reports a torch, the page says to use a lamp. The camera asks for the rear camera at up to 1280x720 (`facingMode: environment`), which iPhone 12 Safari accepts, and falls back to any rear camera.

## Guided tour (`src/tour.js`)

For a caller who has never been in the room. The caller taps **Guided tour** (or says "I've never been in here" and the agent calls `start_tour`). Every 4.5 s while frames arrive, Muse Spark looks at the frame with the room's knowledge-base cards and lists each part it sees (part ids from the cards, e.g. `expansion_tank`, `pressure_relief_valve`, `p_trap`, `main_breaker`), with a status, the visible sign, and a point on it. SAM 3.1 outlines each part from that point, and the label is drawn on the outline. The agent leads the camera: first "show me the whole room slowly", then toward the next part the card expects ("look along the side of the boiler for a brass valve with a pipe going down"), or the move the model picked. Code decides what is said:

- **No fault without a visible sign.** "Needs attention" or "safety issue" without evidence becomes "can't tell from this angle", and the agent asks for the view that would tell.
- **A safety issue needs the card's hazard threshold and SAM.** The model must name a hazard id from the card (e.g. `flue_gap`: a visible gap in the vent pipe), and SAM must find the object by its noun at 0.5 or more. Otherwise it stays "needs attention". A confirmed escalating hazard pages the owner and stops quoting, like a camera hazard.
- **Electrical panels: look, never open.** Every line the agent says, in a tour or not, passes `safeLine()`: a sentence telling the caller to open or remove a cover, or to touch anything inside a box, is replaced in code.
- **A status only moves up.** A fault seen on frame 7 stays, with frame 7 as evidence; a later "can't tell" never hides it.
- When the card's checkpoints are all seen (or after 16 steps), the agent sums up, hands the list to the conversation and offers a price for a visit. A tour call may spend up to $0.60 (other calls $0.25).

## Knowledge base (`kb/`, `src/kb.js`)

Eight short equipment cards (boiler, water heater, under the sink, electrical panel, faucet, stove, outlets and cords, AC/thermostat/sump/disposal), written in our own words from public safety sources listed in `kb/SOURCES.md` (NFPA, U.S. Fire Administration, CPSC, EPA WaterSense, Natural Resources Canada, OSHA). Each card has the parts and what they look like, normal and abnormal signs, common faults and the evidence each needs, hazards with the evidence threshold to escalate, what a homeowner may do, and what we never ask. Retrieval is plain and auditable: the tour room picks its card; otherwise the equipment words heard or outlined on the call pick at most two cards, which go into the agent's context labelled as data. Code reads the thresholds directly (for example: bare wire on a cord that is visibly not plugged in is "needs attention", not an emergency).

## Safety is in code, not in the prompt

- **Spoken hazards end quoting before any model call.** Gas, sparks, smoke, scorching, exposed wiring, water on electrical, carbon monoxide and structural damage, in English and Spanish ("huele a gas", "chispas"), with negation handling ("no huele a gas" is not a hazard).
- **Camera hazards need two models.** Spark lists what it sees (flammables near a burner, water near electrical, exposed wiring, scorch). SAM must outline the named object at confidence 0.5 or more. Otherwise the check shows "unconfirmed" and nothing happens. Agreement on an escalating category pages the owner and blocks quotes and booking. Flammables near heat get a spoken warning and an owner note, and the call goes on. Electrical checks are visual only: the app never claims a measurement.
- **The checklist shows clean results too.** Each check is clear or found, with the frame it used, so a clean result has evidence.
- **Prices come only from the owner's list.** `propose_quote` goes through `verifier.js`: a real row of the list, and a SAM outline with confidence 0.5 or more. Otherwise "the technician confirms on site".
- **Hypotheses need evidence.** `record_hypothesis` is refused unless it cites ledger entries from a frame observation, an outline or the caller's words.
- **Water shut-off steps are fixed text in code.** Anything about gas is refused in code.
- **Nothing is booked by the model.** Only the owner's token approves, and never on a hazard call. The demo calendar is in memory; this repository does not book into Jobber.
- **Spend is capped in code.** Every request, including streamed audio, is priced before the next one: $0.25 per call ($0.60 for a guided tour); each server run has a hard **session spend stop** (`SPEND_STOP_USD`, $5 by default) counted from the ledger when it starts; the public demo switches to replays at $80 of the credit; everything stops at $100.
- **Access code on every page and API.** A random code is made at each server start and written to `.data/access_code` (mode 600), never logged or committed. `/k/<code>` sets an HttpOnly, SameSite=Strict cookie and redirects, so the code leaves the address bar; without it, pages redirect to a code-entry page, APIs answer 401 and the voice WebSocket is closed before any model call. 20 wrong codes in 10 minutes lock that client out. This sits on top of the per-call tokens.
- **Bounds for strangers:** frame and audio size and rate, one message at a time, 6 calls per IP per hour, 10 live calls at once, 15-minute calls, a WebSocket origin check, and voice tokens sent in the first message, never in a URL.
- **Untrusted text stays text.** Text on equipment and caller words are data. Pages render with `textContent` under a strict CSP. Frames are kept in memory for the call only (up to 24 evidence frames); a recorded call keeps events and lines, never media.

## Honest labels

- **Staged scene.** When a scene was arranged for the demo (for example a spray can placed beside a cold burner), the caller ticks "staged scene". A yellow label shows on the video, in the console and in the replay. The detection itself is live.
- **Footage mode.** "Try it with our footage" plays a recorded clip as the camera; its frames go to the models live, and the page says so on the video. Clip credits: `public/footage/ATTRIBUTION.md`.

## Run it

```bash
npm test                              # 75 tests: red team, voice relay, hazards, faucet scenario
META_API_KEY=... npm start            # http://127.0.0.1:8642 (binds to localhost)
META_API_KEY=... node eval/run.mjs    # the eval against the live models
```

On the start page, **Start a call** gives three links: the camera page (the caller), the owner page (approve), and the Agent Console (every step, check, evidence entry, cost and latency, live). **Recorded calls** lists replays.

Every page needs the access code: open `http://127.0.0.1:8642/k/<code from .data/access_code>`.

The phone camera needs HTTPS. For a recording session, `scripts/record_session.sh` starts the server on 127.0.0.1, a Cloudflare quick tunnel to it (temporary https URL, no account), prints the phone link with the code as text and a terminal QR (`scripts/qr.mjs`, no dependencies), opens the Agent Console in its own window (`/console#latest` follows the newest call) and records the Mac screen into `recordings/`; Ctrl-C stops all of it. `--no-tunnel` runs it locally. The phone opens **Pick a take** (`/go`): each take starts a call with a script card, a "start your screen recording now" cue that waits for "I'm recording", and a "you can stop recording now" cue at the end (`public/takes.json`).

## Deploy (one container, not used for the recordings)

The `Dockerfile` runs one instance (calls live in memory). Example for Google Cloud Run, with the key in Secret Manager and the spend already used passed in so the caps still count the account total:

```bash
gcloud run deploy show-me-the-problem --source . --region us-east1 --allow-unauthenticated \
  --max-instances 1 --session-affinity --timeout 900 \
  --set-env-vars SPENT_BASELINE_USD=<ledger total> --set-secrets META_API_KEY=meta-api-key:latest
```

## Eval

`eval/cases.json` holds 38 cases on freely licensed photos (credits in `eval/photos/ATTRIBUTION.md`): water heaters, breaker panels, AC condensers, pipes, a sump pump, disposals, thermostats, outlets and a dripping tap; 10 spoken hazards (2 in Spanish); 3 prompt-injection attempts; 3 junk photos; 1 out-of-scope request. Each case also runs the camera hazard scan on its photo.

Latest full run (`eval/results.json`, Oct 30, 38 cases, $0.97):

| Measure | Result |
|---|---|
| Cases passed | 32 of 38 |
| Spoken hazards escalated | 10 of 10 (including both Spanish cases) |
| False escalations | 2: one photo of a home-made extension cord, where Spark and SAM agreed on bare copper ends (the case was labelled "quote"); one Stab-Lok panel replacement request (ep04), where the verifier's hazard words matched the agent's own quote notes and stopped the price |
| Part outlined by SAM at confidence 0.5 or more | 17 of the 21 cases that should end in a quote (20 of 35 non-junk cases; hazard cases stop before looking). 8 by text prompt, 1 by alternative noun, 11 by a Spark grounding point handed to SAM |
| Camera hazards confirmed by both models | 4 photos (exposed wiring on ep05, ep06, so01, and the extension cord so02); 0 "unconfirmed" |
| Typed-turn latency | p50 4.6 s, p90 14.9 s over 84 turns (one turn can take several tool steps) |

The previous runs: Oct 29, text prompts only, 15 of 32 photos had any box; Oct 30 first grounded run, 22 of 32 at confidence 0.5 or more.

What failed: a disposal (gd03) and a smart-thermostat (th02) photo were never outlined, so the agent asked for a closer photo; the cat photo (jk01) did not end in "send a better photo"; the AC case ac02 and the injection case in02 drifted into faucet questions. That drift came from the faucet instructions, which we then scoped to faucet calls; a re-check of the 5 affected cases passed 5 of 5 (`eval/results_recheck.json`), but the full run above was not repeated. Point prompts make SAM outline whatever is under the point, so a grounded outline's confidence does not prove the object's identity.

Realtime voice, measured live on Oct 30 with synthetic speech: end of speech to the agent's line 1.8 s (English) and 1.6 s (Spanish, which escalated); the transcript arrived word by word as partials. The Spanish test line "huele a gas" was transcribed as "huelga gas", which the code gate does not match; the agent escalated it, not the code.

Dark footage, measured Oct 30: on the dripping-tap clip darkened in software to mean brightness 152, 100, 55, 31 and 12 out of 255, SAM outlined the faucet every time (confidence 0.97–0.98). Software darkening keeps a clean signal; a real dark cabinet adds noise and blur, so the app still asks for light below 45.

We report what was measured, never a perfect score.

## New during the hackathon vs pre-existing

| Part | Status |
|---|---|
| Everything in this repository: agent loop, tools, grounding, mask decoding, guidance, realtime voice relay, camera hazards, checklist, evidence ledger, work order, verifier, budget ledger, pages, eval, tests | **New** (Oct 27 – Nov 4, 2026) |
| Unmanually, the AI office manager product that answers the business's phone | Pre-existing. It is not in this repository. The demo uses a fictional business, a fictional price list and an in-memory calendar. |
| Browser speech synthesis for the agent's voice | Browser built-in |

## License

MIT. Footage and eval photos keep their own licences (see the ATTRIBUTION files).
