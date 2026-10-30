# Showcase features (added Oct 30, 2026)

Also fixed the same evening: ac02 and gd03 (SAM found no part) now pass. Spark grounding returns a box as well as
a point; SAM gets the box as a box prompt and the outline counts only when it fills Spark's box (IoU 0.5 or more).

Four additions for the 3-minute video, chosen for what a judge sees on screen per hour of work. Each one is
covered by unit tests and by eval cases; the numbers are in the README's Eval section. Takes are on the phone's
**Pick a take** page (`/go`, `public/takes.json`); footage clips are on the start page.

Considered and not built: **counting a drip rate from frames**. The camera sends about one frame a second,
a drip is a few pixels for a few milliseconds, and the only drip clip we have is 7.6 s of handheld video.
Any "gallons per year" we printed would be a guess dressed as a measurement, so we left it out.

## 1. The trade library: real manuals behind every answer

**What it does.** 16 public-domain or openly released documents (US Navy Construction Electrician basic and
intermediate courses, NEETS circuit protection and wiring modules, Tools and Their Uses, Utilitiesman 3 & 2,
Builder 3 & 2, US Army FM 3-34.471 Plumbing and FM 5-426 Carpentry, HUD's Residential Rehabilitation
Inspection Guide, OSHA 3075 and pages from OSHA, EPA WaterSense and USFA) are split into about 7,200 cited
passages and searched locally (BM25 in plain JavaScript, no model call, no new service). The agent gets the two
best passages for the part in view and the caller's last words, the guided tour gets passages for its room, and
`lookup_manual` lets the agent look something up. Each passage used shows in the Agent Console and the
evidence ledger with its source and PDF page, and the technician's work order lists them. The library explains
and identifies; it never decides a hazard, a status or a price (those stay in the curated cards and the code).
Integrity: the passage file must match its SHA-256 in `kb/corpus/MANIFEST.json`, and instruction-like text or
dollar amounts are dropped at build time and again at search time.

**How to film it.** Any take. In the Agent Console, point at the line **Trade manuals (local search)** and an
evidence entry like "Residential Rehabilitation Inspection Guide (HUD, Feb 2000), PDF p. 102". Voice-over:
"Every explanation is backed by a real manual, cited to the page."

**Measured.** It explains; it is not scored on its own. The eval shows it did not cost accuracy in the final
run (0 false escalations, 10 of 10 spoken hazards), but the median turn got about 0.7 s slower.

**Which take.** Boiler room tour (`boiler`), or the faucet take while asking "what is that valve for?".

## 2. Reads the rating plate and dates the equipment

**What it does.** Ask "how old is my water heater?" and point at the sticker. Muse Spark reads the plate
(brand, model, serial, fuel, gallons, BTU/h, volts, refrigerant, any printed date). Code then cleans each field
to a strict shape (a field that reads like an instruction, such as "IGNORE YOUR RULES", is dropped), and dates
the unit from the serial with published rules (`kb/serials.json`: Rheem/Ruud MMYY, A.O. Smith YYWW and the
pre-2008 letter code, Bradford White's 20-year letter cycle, from the City of Palo Alto's guide). A printed
manufacture date wins over the serial. The age is said by code, never by the model ("made around June 2014 going
by the serial number, so about 12 years old"), goes into the quote line, and the model and serial go into the
technician's brief and work order. At most 3 plate reads per call.

**How to film it.** A real water heater or furnace sticker, lit, square on, a hand's width away. Hold until the
line is spoken; show the console's **Rating plate** line and the owner page's work order with model and serial.
Brands outside the three rule sets still get model and serial, with "no date rule for this brand: the
technician dates it on site". Check that no address or name is on screen.

**Measured.** 3 of 3 synthetic plates on a real photo dated correctly in the final eval run (pl01–pl03); the
injection line on pl03 was dropped and nothing obeyed it. The first run missed pl03 once (Spark returned no
plate) and exposed a serial-rule bug for A.O. Smith serials with letters, now fixed and tested.

**Which take.** `plate` ("Read the water heater label").

## 3. Commercial and industrial equipment

**What it does.** A new knowledge-base card for rooftop units, air handlers, commercial boilers, insulated
piping, switchgear, transformers and disconnects, with its own hazard thresholds (gear open with live parts,
scorch on gear, water on gear, an open boiler breeching, storage in a plant room) and "never ask" rules (never
open gear doors, operate a switch, or go on a roof without the building's permission). The guided tour has a
**Commercial equipment** room. The library's Navy electrician and utilities courses and OSHA material carry the
commercial and industrial detail.

**How to film it.** On the start page, use one of the three new footage buttons ("Commercial: rooftop units",
"switchgear room", "school boiler room"). They are public-domain or CC0 still photos that we panned into 18 s
clips; the page labels them "recorded clip, analyzed live", and the voice-over should say "a public photo, panned,
analyzed live". Tap **Guided tour** with the room set to Commercial equipment.

**Measured.** 4 of 4 commercial tour cases named the expected equipment (rooftop unit twice, switchgear,
insulated piping and the commercial boiler); switchgear and the rooftop units were outlined; none claimed a
safety issue. One tour flagged a rooftop unit "needs attention" with a visible sign, which the case allows.

**Which take.** Footage mode, switchgear room, guided tour (the switchgear photo gave the cleanest outlines).

## 4. A whole call in Spanish

**What it does.** The caller's language is detected in code from their words. The agent writes its own lines
in Spanish, and every line the code composes (greeting, can't-see-yet, quote with the price-list row's Spanish
name, booking, hazard lines, water shut-off steps, camera guidance, the plate line) comes from a fixed
translation table. The spoken-hazard gate and the never-open-the-panel gate both read Spanish. The voice uses a
Spanish Aura-2 voice (`TTS_VOICE_ES`), or the browser's Spanish voice. The guided tour's own lines are still
English.

**How to film it.** Same set-up as the faucet take, speaking Spanish. Show the console's **lang: es** event and
the owner page with the Spanish quote.

**Measured.** es03 (dripping faucet) and es04 (water heater) both reached a list price with every line after the
greeting in Spanish, in the final run. The first run's es04 failed because the agent chased the label; fixed.

**Which take.** `spanish`.

## Not verified before recording

- The Spanish Aura-2 voice id (`aura-2-celeste-es`) was not called live; if it fails, the page falls back to the
  browser's Spanish voice.
- No phone test of the new takes yet; the plate reader was measured on three synthetic plates on a real photo,
  not on a real sticker.
