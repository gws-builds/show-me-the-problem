# Knowledge base sources

The cards in `kb/cards/` are written in our own words. They summarise public safety guidance and common trade
practice; no text is copied. Each card lists the source ids it relies on. Links were opened on 2026-10-30
(HTTP 200 unless noted; "bot-blocked" pages were confirmed through a search engine the same day).

| id | Source | Used for |
|---|---|---|
| nfpa-heating | NFPA, Heating safety: https://www.nfpa.org/education-and-research/home-fire-safety/heating | clearance around heating equipment, yearly professional service, flammables near heat |
| nfpa-cooking | NFPA, Cooking safety: https://www.nfpa.org/education-and-research/home-fire-safety/cooking | flammables near a burner |
| nfpa-co | NFPA, Carbon monoxide: https://www.nfpa.org/education-and-research/home-fire-safety/carbon-monoxide | CO alarm going off = leave and call; vents kept clear |
| usfa-heating | U.S. Fire Administration, Heating fire safety: https://www.usfa.fema.gov/prevention/home-fires/prevent-fires/heating/ | clearance around furnaces and boilers, professional inspection |
| usfa-cooking | U.S. Fire Administration, Cooking fire safety: https://www.usfa.fema.gov/prevention/home-fires/prevent-fires/cooking/ | keep towels, paper and containers away from the cooktop |
| usfa-elec-card | U.S. Fire Administration, Electrical and appliance fire safety card (PDF): https://www.usfa.fema.gov/downloads/pdf/publications/electrical_appliance_fire_safety_card.pdf | damaged cords replaced, outlets not overloaded |
| usfa-elec-flyer | U.S. Fire Administration, Prevent home electrical fires (PDF): https://www.usfa.fema.gov/downloads/pdf/publications/prevent_home_electrical_fires_flyer.pdf | warm/discoloured outlets, electrical work left to an electrician |
| cpsc-heating | U.S. CPSC, Hazards from furnaces, space heaters and fireplaces: https://www.cpsc.gov/content/cpsc-warns-of-hazards-from-furnaces-space-heaters-and-fireplaces (bot-blocked to scripts) | yearly professional inspection, blocked or disconnected vents, CO |
| epa-leaks | U.S. EPA WaterSense, Fix a Leak: https://www.epa.gov/watersense/fix-leak-week | dripping faucets, leaks under sinks, checking supply lines |
| nrcan-maint | Natural Resources Canada, Home maintenance (ENERGY STAR new homes): https://natural-resources.canada.ca/energy-efficiency/energy-star/new-homes/maintenance | yearly service of heating equipment, filters, drains |
| osha-elec | OSHA, Electrical hazards: https://www.osha.gov/electrical | exposed live parts, water and electricity, never touching energised parts |

What the knowledge base is not: a code book, a diagnosis, or a replacement for the technician. Every card says what a
camera can and cannot show, and the code refuses any claim that has no visible evidence.


## Trade library (`kb/corpus/`, `src/corpus.js`)

Full courses, manuals and guides, used for **explanation and identification** (what a part is, what it does,
what it looks like). They never decide a hazard, a status or a price: the cards above and the code do.
Only U.S. Government works or documents that state they are public domain or approved for unlimited public
release are used, plus one government-distributed guide (HUD) whose licence status is noted. All were
downloaded on 2026-10-30 with a generic browser User-Agent and no identifying information.

How it is built: the raw PDFs and pages go into `kb/corpus/raw/` (gitignored, about 115 MB), `node
scripts/kb_build.mjs` extracts text with `pdftotext`, drops OCR noise, the multiple-choice assignment pages
and any instruction-like or dollar-amount text, and writes cleaned chunks to `kb/corpus/chunks.jsonl.gz`
(7244 chunks, 2.1 MB) with SHA-256 hashes of every raw file and of the chunk
file in `kb/corpus/MANIFEST.json`. The app refuses a chunk file whose hash does not match. Search is local
BM25 in plain JavaScript; citations name the source and the PDF page. Old scanned manuals (1973 Utilitiesman,
Builder 3 & 2) were OCR'd by their archive and contain recognition errors; text may be dated (pre-2000
practice), which is why it only explains and never rules.

| id | Source | URL | Licence basis | Trades / settings | Chunks |
|---|---|---|---|---|---|
| navedtra-14026 | Construction Electrician, Basic (NAVEDTRA 14026, US Navy, Jan 1998) | https://everyspec.com/USN/NAVEDTRA/download.php?spec=NAVEDTRA_14026_JAN1998.018375.PDF | U.S. Government work (17 U.S.C. 105); the PDF states DISTRIBUTION STATEMENT A: Approved for public release; distribution is unlimited. Copy from the EverySpec mirror (the official media.defense.gov copy refuses scripted downloads). | electrical / residential, commercial, industrial | 754 |
| navedtra-14027 | Construction Electrician, Intermediate (NAVEDTRA 14027, US Navy, Oct 1998) | https://everyspec.com/USN/NAVEDTRA/download.php?spec=NAVEDTRA_14027_OCT1998.018377.PDF | U.S. Government work (17 U.S.C. 105); DISTRIBUTION STATEMENT A: Approved for public release; distribution is unlimited. | electrical / commercial, industrial | 608 |
| neets-03 | NEETS Module 3: Circuit Protection, Control and Measurement (NAVEDTRA 14175, US Navy, Sep 1998) | https://everyspec.com/USN/NAVEDTRA/download.php?spec=NAVEDTRA_14175_SEP1998.018396.PDF | U.S. Government work (17 U.S.C. 105); DISTRIBUTION STATEMENT A: Approved for public release; distribution is unlimited. | electrical / residential, commercial, industrial | 303 |
| neets-04 | NEETS Module 4: Electrical Conductors, Wiring Techniques and Schematic Reading (NAVEDTRA 14176, US Navy, Sep 1998) | https://everyspec.com/USN/NAVEDTRA/download.php?spec=NAVEDTRA_14176_SEP1998.018397.PDF | U.S. Government work (17 U.S.C. 105); DISTRIBUTION STATEMENT A: Approved for public release; distribution is unlimited. | electrical / residential, commercial, industrial | 154 |
| navedtra-14256 | Tools and Their Uses (NAVEDTRA 14256, US Navy, Jun 1992) | https://everyspec.com/USN/NAVEDTRA/download.php?spec=NAVEDTRA_14256_JUN1992.018379.PDF | U.S. Government work (17 U.S.C. 105); DISTRIBUTION STATEMENT A: Approved for public release; distribution is unlimited. | general, carpentry, plumbing, electrical / residential, commercial, industrial | 403 |
| ut-3-2 | Utilitiesman 3 and 2, Rate Training Manual (US Navy, revised 1973; ERIC ED097442) | https://archive.org/download/ERIC_ED097442/ERIC_ED097442.pdf | U.S. Government work (17 U.S.C. 105). The manual credits some illustrations to outside sources; only text is kept here, no figures. | plumbing, hvac / residential, commercial, industrial | 2063 |
| bu-3-2 | Builder 3 and 2, Rate Training Manual (US Navy, revised; ERIC ED210471) | https://archive.org/download/ERIC_ED210471/ERIC_ED210471.pdf | U.S. Government work (17 U.S.C. 105). Text only. | carpentry, general / residential, commercial | 1662 |
| fm-3-34-471 | FM 3-34.471 Plumbing, Pipe Fitting, and Sewerage (US Army, Aug 2001) | https://archive.org/download/FM_3_34_471_P_2001/FM%203-34-471%20Plumbing%2C%20pipe%20fitting%2C%20and%20sewerage%20%282001%29.pdf | U.S. Government work (17 U.S.C. 105); the manual states: Approved for public release; distribution is unlimited. Historical edition (superseded by TM 3-34.70). | plumbing, hvac / residential, commercial, industrial | 425 |
| fm-5-426 | FM 5-426 Carpentry (US Army, Oct 1995) | https://archive.org/download/MManuals/UsArmyEngineerCarpentry1995.pdf | U.S. Government work (17 U.S.C. 105); the manual states: Approved for public release; distribution is unlimited. Historical edition (superseded by TM 3-34.47, same content per EverySpec). | carpentry / residential, commercial | 360 |
| hud-rrig | Residential Rehabilitation Inspection Guide (HUD, Feb 2000) | https://www.huduser.gov/publications/pdf/rehabinspect.pdf | Distributed free by HUD USER with no copyright notice. Prepared by a contractor, so not automatically a U.S. Government work: used for search and short cited excerpts only, with attribution. | general, electrical, plumbing, hvac, carpentry / residential | 389 |
| osha-3075 | Controlling Electrical Hazards (OSHA 3075, 2002 revised) | https://www.osha.gov/sites/default/files/publications/osha3075.pdf | The publication states it is in the public domain and may be reproduced fully or partially without permission. | electrical / commercial, industrial, residential | 88 |
| osha-electrical | OSHA, Electrical: overview (web page) | https://www.osha.gov/electrical | U.S. Government work (17 U.S.C. 105). Text only. | electrical / commercial, industrial | 5 |
| osha-loto | OSHA, Control of Hazardous Energy (Lockout/Tagout): overview (web page) | https://www.osha.gov/control-hazardous-energy | U.S. Government work (17 U.S.C. 105). Text only. | electrical, general / commercial, industrial | 8 |
| epa-fix-leak | EPA WaterSense, Fix a Leak Week (web page) | https://www.epa.gov/watersense/fix-leak-week | U.S. Government work (17 U.S.C. 105). Text only. | plumbing / residential | 11 |
| epa-faucets | EPA WaterSense, Bathroom Faucets (web page) | https://www.epa.gov/watersense/bathroom-faucets | U.S. Government work (17 U.S.C. 105). Text only. | plumbing / residential | 10 |
| usfa-heating | U.S. Fire Administration, Heating fire safety (web page) | https://www.usfa.fema.gov/prevention/home-fires/prevent-fires/heating/ | U.S. Government work (17 U.S.C. 105). Text only. | hvac / residential | 1 |

Tried and not used: the official media.defense.gov copies of NAVEDTRA 14265A (Utilitiesman Basic) and
14026 refused scripted downloads (HTTP 403), as did marines.mil, FEMA P-348, CPSC and the DOE Energy Saver
pages; we did not try to get around those blocks.

## Serial-number date rules (`kb/serials.json`)

Water heater date codes, written in our own words from the City of Palo Alto, "Check Your Water Heater's
Age" (https://www.paloalto.gov/Departments/Utilities/Electrification/Electrify-My-Home/Switch-to-a-Heat-Pump-Water-Heater/Check-Your-Water-Heaters-Age),
read on 2026-10-30: Rheem/Ruud MMYY, A.O. Smith YYWW (current) and letter-month + YY (pre-2008), Bradford
White year letter + month letter on a 20-year cycle. A date code is a convention, not a guarantee: the
app says "estimated", prefers a printed manufacture date, and the technician confirms.
