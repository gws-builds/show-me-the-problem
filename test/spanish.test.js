// Spanish calls: language detection, translated code lines, the panel gate in Spanish, and a whole
// faucet call in Spanish through the real call layer with a scripted model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, toLang, TRANSLATED_LINES, SHUTOFF_ES } from '../src/i18n.js';
import { SHUTOFF_PLAYBOOK } from '../src/evidence.js';
import { safeLine, SAFE_PANEL_LINE } from '../src/tour.js';
import { createSession, instructionsFor } from '../src/agent.js';
import { hazardIn } from '../src/verifier.js';

test('detects Spanish and English callers; short or mixed words keep the current language', () => {
  assert.equal(detectLang('Hola, mi grifo de la cocina gotea por debajo de la manija'), 'es');
  assert.equal(detectLang('El calentador de agua no calienta, ¿cuánto cuesta?'), 'es');
  assert.equal(detectLang('My kitchen faucet drips from under the handle'), 'en');
  assert.equal(detectLang('ok'), null);
  assert.equal(detectLang('sí'), null);
  const s = createSession();
  s.heard('Hola, el grifo de mi cocina gotea'); assert.equal(s.lang(), 'es');
  s.heard('sí'); assert.equal(s.lang(), 'es', 'a one-word answer does not switch back');
  assert.match(instructionsFor(s), /The caller speaks Spanish/);
  assert.ok(s.events().some((e) => e.kind === 'lang' && e.lang === 'es'));
});

test('every fixed code line and every shut-off step has a Spanish version', () => {
  for (const l of TRANSLATED_LINES) assert.notEqual(toLang(l, 'es'), l, l);
  for (const steps of Object.values(SHUTOFF_PLAYBOOK)) for (const st of steps) assert.ok(SHUTOFF_ES.has(st), `no Spanish for: ${st}`);
  assert.equal(toLang('Hola, ¿me muestra el grifo?', 'es'), 'Hola, ¿me muestra el grifo?', 'the model\'s Spanish passes through');
  assert.equal(toLang('Move closer.', 'en'), 'Move closer.');
});

test('lines with values: quote, booking, plate and "can\'t see yet" come out in Spanish with the list price unchanged', () => {
  const labelEs = (l) => (l === 'Faucet cartridge replacement (standard cartridge included)' ? 'Cambio del cartucho del grifo (cartucho estándar incluido)' : l);
  assert.equal(toLang('For Faucet cartridge replacement (standard cartridge included) the price is $229.00. The technician confirms on site.', 'es', { labelEs }),
    'Para Cambio del cartucho del grifo (cartucho estándar incluido) el precio es $229.00. El técnico lo confirma en el lugar.');
  assert.match(toLang('For Water heater flush and inspection the price is $189.00. The technician confirms on site. Your water heater is about 12 years old by its label, and the technician will bring the model details.', 'es'), /\$189\.00.*su calentador de agua tiene unos 12 años/);
  assert.equal(toLang('I have asked the owner to confirm Monday, Nov 2, 9-11 AM. You will get a text when it is booked.', 'es'), 'Le pedí al dueño que confirme Monday, Nov 2, 9-11 AM. Le llegará un mensaje cuando quede agendado.');
  assert.equal(toLang("I can't see the faucet yet. Incline el teléfono hacia abajo.", 'es'), 'Todavía no lo veo. Incline el teléfono hacia abajo.');
  assert.match(toLang('Got the label: a Rheem water heater, made around June 2014 going by the serial number, so about 12 years old. I\'ve added the model and serial for the technician.', 'es'), /Rheem calentador de agua, fabricado alrededor de junio 2014 según el número de serie, o sea unos 12 años/);
  const steps = SHUTOFF_PLAYBOOK.sink;
  assert.doesNotMatch(toLang(`${steps[0]} ${steps[1]} I will outline the valves when I see them.`, 'es'), /[A-Z][a-z]+ the /);
});

test('red team: the panel gate also reads Spanish (open the cover, touch the wires), and negations pass', () => {
  for (const bad of ['Quite la tapa del panel para ver los cables.', 'Abra la cubierta del tablero, por favor.', 'Toque los cables para ver si están flojos.', 'Meta la mano y mueva los cables de adentro.', 'Destornille la tapa de la caja eléctrica.', 'No worries, open the panel cover.']) {
    const r = safeLine(bad); assert.equal(r.blocked, true, bad); assert.equal(r.text, SAFE_PANEL_LINE);
  }
  for (const fine of ['Por favor, no abra la tapa ni toque nada adentro.', 'Nunca toque los cables.', 'Abra el mueble debajo del fregadero.', 'Please do not open the cover or touch anything inside.']) assert.equal(safeLine(fine).blocked, false, fine);
  assert.equal(toLang(SAFE_PANEL_LINE, 'es'), 'Retroceda un paso para ver todo el panel. Por favor, no abra la tapa ni toque nada adentro.');
  assert.equal(safeLine(toLang(SAFE_PANEL_LINE, 'es')).blocked, false, 'our own Spanish safe line passes the gate');
});

test('red team: Spanish hazards still end quoting in code; a Spanish "no hay olor a gas" does not', () => {
  assert.ok(hazardIn('Huele a gas en la cocina'));
  assert.ok(hazardIn('Salen chispas del enchufe'));
  assert.ok(!hazardIn('No huele a gas, solo gotea el grifo'));
});
