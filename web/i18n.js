// The interface in another language.
//
// Borrowed in shape from the French contributor's own build of this idea
// (`QWEN UI - partage.zip`, `public/i18n.js`), with two deliberate changes.
//
// **Keyed on English, not French.** Theirs keys on the French source string,
// which is right for a French codebase and wrong for this one: every string
// here is authored in English, and keying on French would mean writing every
// future label in a language the codebase is not written in before it could
// be shown at all. `en` is therefore the source language and needs no
// dictionary — it can never be missing one, and a missing translation falls
// back to it rather than to a blank.
//
// **Stored on the account, not in localStorage.** Theirs uses localStorage,
// which is per browser: signing in from a phone would put someone back into a
// language they do not read. This app already has accounts and a preferences
// record, so the choice follows the person. localStorage is still used, but
// only as a cache and only for the login wall — see `resolve()`.
//
// The part worth copying verbatim is the MutationObserver. This app builds
// most of its interface in JavaScript: templates are cloned per model, chips
// and rows are created as results arrive, and a one-shot pass over the DOM at
// load would translate the shell and nothing anyone actually reads. The
// observer means app.js needs no translation calls at all, which is why this
// change touches one file rather than every string site in a 5,000-line file.
//
// ── What this does NOT translate, deliberately ──
//
// Strings built by interpolation — "3 of 5 segments · next: Negative prompt",
// "120 words · target 80–120" — cannot be looked up, because the key would
// have to contain the number. They stay in English. Opting one in is a call
// to `uiText()` with a fixed key at the site that builds it; there is no
// attempt here to guess at them with regexes, which is how this kind of file
// starts corrupting output. Model names, tag names, prompt text and anything
// the LLM wrote are never touched for the same reason — a `purple_hair` that
// got translated would be a broken prompt.

const DICTIONARIES = {
  fr: {
    // ── chrome ──
    'Prompt Assistance': "Assistance à l'écriture",
    'LoRA Training': 'Entraînement LoRA',
    'Image Analysis': "Analyse d'image",
    // The shared image/prompt board. Not "Bibliothèque" — that is already
    // spoken for by the saved-prompt library on Tab 1, two entries down.
    Pinboard: "Tableau d'affichage",
    'Image Models': "Modèles d'image",
    'Video Models': 'Modèles vidéo',
    Chat: 'Discussion',
    Library: 'Bibliothèque',
    People: 'Personnes',
    Accounts: 'Comptes',
    Preferences: 'Préférences',
    Profile: 'Profil',
    Model: 'Modèle',
    Output: 'Sortie',
    Image: 'Image',
    Video: 'Vidéo',
    Build: 'Version',
    'Loading…': 'Chargement…',
    Close: 'Fermer',
    Clear: 'Effacer',
    Refresh: 'Actualiser',
    Refine: 'Affiner',
    Download: 'Télécharger',
    'Copy all': 'Tout copier',
    'Copy all tags': 'Copier tous les tags',
    'Copy general': 'Copier les tags généraux',
    'New chat': 'Nouvelle discussion',
    'Reload prompts': 'Recharger les prompts',
    'Offload all': 'Tout décharger',
    'On the GPU': 'Sur le GPU',
    'It shares the GPU': 'Le GPU est partagé',
    'Active now': 'En ligne',
    'Model notes': 'Notes sur les modèles',
    'Model requests': 'Demandes de modèle',
    'Request a model': 'Demander un modèle',
    'Model tag': 'Étiquette du modèle',
    'Model to open on': "Modèle à l'ouverture",
    'Model for prompt assistance': "Modèle pour l'assistance",
    'How chat works': 'Fonctionnement de la discussion',
    'No prompt yet': 'Aucun prompt pour le moment',
    'Preview will appear here': "L'aperçu apparaîtra ici",
    'Applied the next time you open the app.': "Appliqué à la prochaine ouverture de l'application.",
    'Nothing automatic.': 'Rien d’automatique.',
    'Keeping one': 'En conserver une',

    // ── accounts ──
    Password: 'Mot de passe',
    'Current password': 'Mot de passe actuel',
    'New password': 'Nouveau mot de passe',
    'New password again': 'Confirmer le nouveau mot de passe',
    'Change password': 'Changer le mot de passe',
    'Create account': 'Créer un compte',
    'Back to sign in': 'Retour à la connexion',
    'Display name': "Nom affiché",
    'At least 8 characters.': 'Au moins 8 caractères.',
    'How did you hear about us?': 'Comment avez-vous connu cet outil ?',

    // ── the builder ──
    Brief: 'Consigne',
    'Creative brief': 'Consigne créative',
    'Quality preset': 'Préréglage de qualité',
    Aspect: 'Format',
    Source: 'Source',
    Style: 'Style',
    'Style guidance': 'Orientation stylistique',
    Mode: 'Mode',
    Quality: 'Qualité',
    Duration: 'Durée',
    'Duration (s)': 'Durée (s)',
    'Start (s)': 'Début (s)',
    'End (s)': 'Fin (s)',
    'Frame rate': "Fréquence d'images",
    Frames: 'Images',
    'Model size': 'Taille du modèle',
    Thinking: 'Raisonnement',
    Audio: 'Audio',
    Role: 'Rôle',
    References: 'Références',
    'Streams used': 'Flux utilisés',
    'Traits to keep': 'Traits à conserver',
    'Traits to drop': 'Traits à écarter',
    'First frame': 'Première image',
    'Last frame': 'Dernière image',
    'I2V reference': 'Référence image-vers-vidéo',
    'Negative prompt': 'Prompt négatif',
    Details: 'Détails',
    Creativity: 'Créativité',
    Length: 'Longueur',
    Default: 'Par défaut',
    words: 'mots',
    tokens: 'jetons',
    Minimal: 'Minimal',
    Exhaustive: 'Exhaustif',
    Precise: 'Précis',
    Wild: 'Libre',
    'Tags detected in your description': 'Tags détectés dans votre description',
    'Search tags...': 'Rechercher un tag…',
    'Describe what you want, in tags or plain English.':
      'Décrivez ce que vous voulez, en tags ou en langage courant.',
    'Describe the scene as you would to someone drawing it without seeing it.':
      'Décrivez la scène comme à quelqu’un qui la dessinerait sans la voir.',
    'Mix tags and description freely. Tags carry identity, prose carries the scene.':
      'Mélangez tags et description. Les tags portent l’identité, la prose porte la scène.',
    'One continuous action, one camera move.':
      'Une seule action continue, un seul mouvement de caméra.',
    'What happens across this stretch.': 'Ce qui se passe sur cet intervalle.',
    'Trigger words, artist tags, anything that must appear as written.':
      'Mots déclencheurs, tags d’artiste, tout ce qui doit apparaître tel quel.',

    // ── image analysis ──
    'Drop an image here or click to browse':
      'Déposez une image ici ou cliquez pour parcourir',
    'PNG, JPG or WEBP': 'PNG, JPG ou WEBP',
    'General threshold': 'Seuil général',
    'Character threshold': 'Seuil personnage',
    'Reference image': 'Image de référence',
    optional: 'facultatif',
  },

  de: {
    // ── chrome ──
    'Prompt Assistance': 'Prompt-Assistenz',
    'LoRA Training': 'LoRA-Training',
    'Image Analysis': 'Bildanalyse',
    Pinboard: 'Pinnwand',
    'Image Models': 'Bildmodelle',
    'Video Models': 'Videomodelle',
    Chat: 'Chat',
    Library: 'Bibliothek',
    People: 'Personen',
    Accounts: 'Konten',
    Preferences: 'Einstellungen',
    Profile: 'Profil',
    Model: 'Modell',
    Output: 'Ausgabe',
    Image: 'Bild',
    Video: 'Video',
    Build: 'Version',
    'Loading…': 'Wird geladen…',
    Close: 'Schließen',
    Clear: 'Leeren',
    Refresh: 'Aktualisieren',
    Refine: 'Verfeinern',
    Download: 'Herunterladen',
    'Copy all': 'Alles kopieren',
    'Copy all tags': 'Alle Tags kopieren',
    'Copy general': 'Allgemeine Tags kopieren',
    'New chat': 'Neuer Chat',
    'Reload prompts': 'Prompts neu laden',
    'Offload all': 'Alle entladen',
    'On the GPU': 'Auf der GPU',
    'It shares the GPU': 'Die GPU wird geteilt',
    'Active now': 'Jetzt aktiv',
    'Model notes': 'Modellnotizen',
    'Model requests': 'Modellanfragen',
    'Request a model': 'Modell anfragen',
    'Model tag': 'Modell-Tag',
    'Model to open on': 'Modell beim Öffnen',
    'Model for prompt assistance': 'Modell für die Prompt-Assistenz',
    'How chat works': 'Wie der Chat funktioniert',
    'No prompt yet': 'Noch kein Prompt',
    'Preview will appear here': 'Die Vorschau erscheint hier',
    'Applied the next time you open the app.':
      'Wird beim nächsten Öffnen der App angewendet.',
    'Nothing automatic.': 'Nichts geschieht automatisch.',
    'Keeping one': 'Eine behalten',

    // ── accounts ──
    Password: 'Passwort',
    'Current password': 'Aktuelles Passwort',
    'New password': 'Neues Passwort',
    'New password again': 'Neues Passwort wiederholen',
    'Change password': 'Passwort ändern',
    'Create account': 'Konto erstellen',
    'Back to sign in': 'Zurück zur Anmeldung',
    'Display name': 'Anzeigename',
    'At least 8 characters.': 'Mindestens 8 Zeichen.',
    'How did you hear about us?': 'Wie haben Sie von uns erfahren?',

    // ── the builder ──
    Brief: 'Vorgabe',
    'Creative brief': 'Kreative Vorgabe',
    'Quality preset': 'Qualitätsvorgabe',
    Aspect: 'Seitenverhältnis',
    Source: 'Quelle',
    Style: 'Stil',
    'Style guidance': 'Stilvorgabe',
    Mode: 'Modus',
    Quality: 'Qualität',
    Duration: 'Dauer',
    'Duration (s)': 'Dauer (s)',
    'Start (s)': 'Start (s)',
    'End (s)': 'Ende (s)',
    'Frame rate': 'Bildrate',
    Frames: 'Bilder',
    'Model size': 'Modellgröße',
    Thinking: 'Denkmodus',
    Audio: 'Audio',
    Role: 'Rolle',
    References: 'Referenzen',
    'Streams used': 'Verwendete Spuren',
    'Traits to keep': 'Zu behaltende Merkmale',
    'Traits to drop': 'Zu verwerfende Merkmale',
    'First frame': 'Erstes Bild',
    'Last frame': 'Letztes Bild',
    'I2V reference': 'Bild-zu-Video-Referenz',
    'Negative prompt': 'Negativer Prompt',
    Details: 'Details',
    Creativity: 'Kreativität',
    Length: 'Länge',
    Default: 'Standard',
    words: 'Wörter',
    tokens: 'Token',
    Minimal: 'Minimal',
    Exhaustive: 'Erschöpfend',
    Precise: 'Präzise',
    Wild: 'Frei',
    'Tags detected in your description': 'In Ihrer Beschreibung erkannte Tags',
    'Search tags...': 'Tag suchen…',
    'Describe what you want, in tags or plain English.':
      'Beschreiben Sie, was Sie möchten – als Tags oder in normaler Sprache.',
    'Describe the scene as you would to someone drawing it without seeing it.':
      'Beschreiben Sie die Szene so, wie jemandem, der sie zeichnet, ohne sie zu sehen.',
    'Mix tags and description freely. Tags carry identity, prose carries the scene.':
      'Mischen Sie Tags und Beschreibung. Tags tragen die Identität, der Fließtext die Szene.',
    'One continuous action, one camera move.':
      'Eine durchgehende Handlung, eine Kamerabewegung.',
    'What happens across this stretch.': 'Was in diesem Abschnitt geschieht.',
    'Trigger words, artist tags, anything that must appear as written.':
      'Triggerwörter, Künstler-Tags, alles was wortwörtlich erscheinen muss.',

    // ── image analysis ──
    'Drop an image here or click to browse':
      'Bild hierher ziehen oder zum Auswählen klicken',
    'PNG, JPG or WEBP': 'PNG, JPG oder WEBP',
    'General threshold': 'Allgemeiner Schwellenwert',
    'Character threshold': 'Charakter-Schwellenwert',
    'Reference image': 'Referenzbild',
    optional: 'optional',
  },
};

/** The source language. Never has a dictionary and never needs one. */
const SOURCE = 'en';
const CACHE_KEY = 'promptforge-language';

let current = SOURCE;

// The original text of every node this has touched, so switching language
// twice translates from English each time rather than from the last
// translation. Without it, en → fr → de looks up French keys in the German
// dictionary, misses every one, and leaves the interface in French.
//
// WeakMap so a node that leaves the DOM — and this app removes a great many,
// every model switch — is collectable rather than pinned here forever.
const originalText = new WeakMap();
const originalAttrs = new WeakMap();

/** Translate one string, or return it unchanged. */
export function uiText(value) {
  if (current === SOURCE) return value;
  return DICTIONARIES[current]?.[value] ?? value;
}

/** The language in use right now. */
export function uiLanguage() {
  return current;
}

/** Every language with a dictionary, plus the source. */
export function uiLanguages() {
  return [SOURCE, ...Object.keys(DICTIONARIES)];
}

// Whitespace is preserved around the translated text rather than trimmed into
// it: markup like `<span>Model </span>` and `>\n  Accounts\n<` are both common
// here, and collapsing that changes the layout.
function translateTextNode(node) {
  const raw = originalText.get(node) ?? node.nodeValue;
  const trimmed = raw.trim();
  if (!trimmed) return;
  originalText.set(node, raw);
  const next = raw.replace(trimmed, uiText(trimmed));
  if (node.nodeValue !== next) node.nodeValue = next;
}

// placeholder and title only. Not `value` — that is data on an input, and
// translating it would change what gets submitted. Not `alt` either: the alt
// text here is filenames.
const ATTRS = ['placeholder', 'title'];

function translateElement(el) {
  if (!el || el.nodeType !== 1) return;
  // Not one rule but two, and conflating them was a bug.
  //
  // OPAQUE — nothing inside is touched, attributes included. `<script>` and
  // `<style>` are code; a `<pre>` here holds a model's verbatim output, and
  // the failure table requires a GPU OOM message reach the user word for
  // word. Also anything marked as content rather than chrome: prompt text,
  // tag names, model names.
  if (el.matches?.('script, style, pre, code') || el.hasAttribute?.('data-no-i18n')) return;

  for (const attr of ATTRS) {
    if (!el.hasAttribute?.(attr)) continue;
    let saved = originalAttrs.get(el);
    if (!saved) {
      saved = {};
      originalAttrs.set(el, saved);
    }
    const current = el.getAttribute(attr);
    // The English source is remembered so switching language twice does not
    // translate a translation. But an element whose title the app REWRITES at
    // runtime would then be pinned to whatever it said the first time this
    // ran — the observer would keep putting the old string back, and the new
    // one would never be seen in any language, English included.
    //
    // Found 27 Aug 2026 on the reference card's "Add tags" button, whose
    // title now names how many tags the current role will actually add: it
    // stayed on the first count through every role change. Text nodes never
    // had this — translateText re-reads its source each pass — so it was
    // attributes alone, and only on elements that outlive their own label.
    //
    // A value matching neither the saved English nor its translation can only
    // have come from the app, so it becomes the new source.
    if (!(attr in saved) || (current !== saved[attr] && current !== uiText(saved[attr]))) {
      saved[attr] = current;
    }
    const next = uiText(saved[attr]);
    if (current !== next) el.setAttribute(attr, next);
  }

  // VALUE-BEARING — the attributes above are chrome and translate, but the
  // text inside is the field's VALUE and must not. A `<textarea>`'s child
  // text node is what gets submitted; translating it would rewrite what
  // someone typed, or ship a translated default brief to the model.
  //
  // Skipping the element outright is what shipped first, and it cost the
  // placeholders: every textarea in the builder kept its English prompt in
  // French and German, which is the largest piece of guidance on the page.
  if (el.matches?.('textarea')) return;

  for (const child of el.childNodes) {
    if (child.nodeType === 3) translateTextNode(child);
    else if (child.nodeType === 1) translateElement(child);
  }
}

/** Repaint the whole document in the current language. */
export function applyLanguage() {
  document.documentElement.lang = current;
  if (document.body) translateElement(document.body);
}

/**
 * Set the language and repaint. Does not save — the caller decides whether
 * this is a person choosing (save it) or a preferences payload arriving on
 * load (already saved).
 */
export function setLanguage(lang) {
  const next = uiLanguages().includes(lang) ? lang : SOURCE;
  if (next === current) return current;
  current = next;
  // Cached for the login wall, which renders before any account is known.
  try { localStorage.setItem(CACHE_KEY, next); } catch { /* private mode */ }
  applyLanguage();
  return current;
}

/**
 * The language to start in, before preferences have loaded.
 *
 * localStorage, then the browser's own list, then English. The account is the
 * authority and overrides this the moment `/api/me` answers — but the login
 * wall is on screen before that, and showing it in English to someone who has
 * already chosen French every session is the thing this avoids.
 */
export function resolveInitialLanguage() {
  try {
    const saved = localStorage.getItem(CACHE_KEY);
    if (saved && uiLanguages().includes(saved)) return saved;
  } catch { /* private mode */ }
  for (const tag of navigator.languages ?? [navigator.language ?? '']) {
    const base = String(tag).split('-')[0].toLowerCase();
    if (uiLanguages().includes(base)) return base;
  }
  return SOURCE;
}

/**
 * Start translating, and keep translating.
 *
 * The observer is the whole reason app.js needs no changes: this app clones a
 * template per model, and builds chips, rows, cards and error boxes as results
 * arrive. A single pass at load would translate the shell and none of what a
 * person actually looks at.
 */
export function startI18n() {
  current = resolveInitialLanguage();
  applyLanguage();

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateTextNode(r.target);
      else if (r.type === 'attributes') translateElement(r.target);
      else for (const node of r.addedNodes) {
        if (node.nodeType === 3) translateTextNode(node);
        else if (node.nodeType === 1) translateElement(node);
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}
