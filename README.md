# Show Me the Problem

**A live call that sees.** A homeowner calls a plumbing, HVAC or electrical business and points their phone at what is broken. An agent built on four Meta models:

- watches the part through the camera;
- tells the caller where to point it;
- asks the one question that changes the price;
- quotes only from the owner's own price list;
- escalates anything dangerous at once;
- requests a booking that the owner approves with one tap.

It is built for the Meta Global AI Developer Hackathon (building period Oct 27 – Nov 4, 2026).

## Why it is not an image analyzer

The photo is a sensor inside an agent that talks, decides, verifies and acts. The agent runs the call:

- It picks one tool per step: find the part, direct the camera, ask, read the price list, check the calendar, propose a quote, escalate, or request a booking.
- While the caller moves the phone, it keeps re-checking the live frames.
- It stops only when it has a verified answer, or when it hands the call to the owner.

## The Meta models and what each one does

| Model | Job in the call |
|---|---|
| **SAM 3.1** | Finds the named part ("relief valve", "breaker panel") in the live frame, with a box and a confidence score. It re-checks new frames while the caller moves the camera, up to 6 checks. |
| **Muse Voice Transcribe 1.0** | Turns each push-to-talk clip, a 16 kHz WAV recorded in the browser, into text. |
| **Muse Spark 1.3** | The agent. It uses function tools with `parallel_tool_calls: false`: one decision per step, at most 4 steps per caller turn and 12 turns per call. |
| **Muse Image 1.0** | After the owner approves, it marks the part on the caller's photo for the technician. |

## Safety is in code, not in the prompt

- **Hazards end quoting before the model is asked.** Gas, sparks, smoke, scorching, exposed wiring, water on electrical, CO alarms and structural damage all trigger it. When the caller's words show a hazard, `calls.js` escalates in code, pages the owner and blocks booking, without any model call. The check is negation-aware: "no sparks" is not a hazard, and the eval and tests measure both directions.
- **Prices come only from the owner's list.** `propose_quote` goes through `verifier.js`. The caller hears a price only when the model names a real row of the list and SAM found the part with confidence of at least 0.5. Otherwise the caller hears "the technician confirms on site" or is asked for a closer photo.
- **Nothing is booked by the model.** `request_booking` queues a request. Only the owner's token can approve it, and a hazard call can never be approved.
- **The spend is capped in code.** Every request is priced from its usage report before the next one starts:
  - $0.25 per call;
  - the public demo replays recorded calls once the credit ledger reaches $80;
  - every call stops at $100.
- **Bounds for strangers:**
  - frame size and rate;
  - audio size and rate;
  - one message at a time;
  - 6 calls per IP per hour;
  - 10 live calls at once;
  - calls expire after 15 minutes.
- **Untrusted text stays text.** Text on the equipment and words from the caller are data. Pages render with `textContent` only, under a strict CSP. Frames and audio are held in memory for the call only; a recorded call keeps the events, never the media.

## Run it

```bash
npm test                       # 36 tests, including the red team (test/calls.test.js)
META_API_KEY=... npm start     # http://127.0.0.1:8642
META_API_KEY=... node eval/run.mjs   # the 35-case eval against the live models
```

On the start page, open **Start a call**. That gives three links:
- the camera page, which is the caller;
- the owner page, where you approve;
- the Agent Console, which shows every step, tool call, verifier check and cost live.

## Eval

`eval/cases.json` holds 35 cases on freely licensed photos (credits in `eval/photos/ATTRIBUTION.md`):

- water heaters, breaker panels, AC condensers, pipes, a sump pump, disposals, thermostats and outlets;
- 10 hazards;
- 3 prompt-injection attempts;
- 3 junk photos;
- 1 out-of-scope request.

`eval/results.json` is the latest run (Oct 29): 26 of 35 cases passed, all 8 hazard cases escalated, 0 false escalations, and SAM found the named part in 15 of 32 photos (when it misses, the agent asks for a better angle instead of guessing). We report what was measured, never a perfect score.

## New during the hackathon vs pre-existing

| Part | Status |
|---|---|
| Everything in this repository: agent loop, tools, verifier, hazard gate, budget ledger, live-call server, camera/owner/console pages, eval set and harness, tests | **New** (Oct 27 – Nov 4, 2026) |
| Unmanually, the AI office manager product that answers the business's phone and syncs with Jobber | Pre-existing. It is not in this repository. The demo uses a fictional business and price list, and an in-memory calendar. |
| Browser speech synthesis for the agent's voice | Browser built-in |

## License

MIT
