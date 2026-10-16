// Reference images on the image models, turned into prompt text.
//
// Deliberately NOT server/references.mjs. That file answers to the DaSiWa
// MiniMax H3 Director and its label classes — `<Picture N>` for frame anchors,
// `<Subject N>` for referenced content — which is a contract with a specific
// consumer, settled by reading that node's source. This one answers to nothing
// but the image prompt files, and inventing `<Picture 1>` for Illustrious
// would be citing a convention that has no reader.
//
// The two also model different things. H3's roles say what KIND of reference
// a file is in a video pipeline. These say what a picture is FOR and how hard
// to follow it, which is the question a tag dump cannot answer: the same
// photograph is a character sheet, an outfit swatch or a lighting study
// depending on what the person wanted from it, and the tags read identically
// in all three cases.
//
// **The model sees the picture now.** This file said the opposite until
// 8 Sep 2026, and the change is the reason it was written: the tagger's list
// went into the prompt automatically, so a reference was only ever as good as
// a class filter over Danbooru vocabulary. The owner's objection, and it is
// the right one — "the whole point was that the llm sees the reference image,
// not the tagger auto inject".
//
// So the picture itself travels in the generation call (see the reference
// block in server.mjs), and what this file writes is the part the picture
// cannot say: what the reference is FOR, how hard to follow it, whose coat it
// is, and whatever the person typed. A model looking at a photograph has no
// way to know it was attached for the lighting.
//
// **Tags are no longer automatic.** The taggers still run — they cost no
// generation time, they run on an otherwise idle CPU, and animetimm is the
// only thing on this box that reliably names a character — but their output
// is now a list the person picks from. Whatever arrives in `tags` was chosen
// by hand, so this file passes it through rather than filtering it: a tag
// somebody clicked and then could not find in the prompt is a worse failure
// than a tag that did not suit its role.

// Under web/ because the browser greys the same chips this strips, off the
// same list. See its header for where the line sits.
import { ROLE_CARRIES_CHARACTER } from '../web/appearance.js';

/**
 * The references in the order everything downstream numbers them in, with
 * each one's role normalised to a role the registry actually declares.
 *
 * Grouped by role rather than left in upload order. Two outfit references are
 * one instruction about clothing, and interleaving them with a background and
 * a pose makes the model reconcile them one at a time against everything
 * else. Registry order, so the grouping is the owner's.
 *
 * **Exported because the numbering has three consumers now, and they have to
 * agree.** This function was inline here until 8 Sep 2026, which was fine
 * while these lines were the only thing the model got. The pictures travel
 * now, and the picture parts were being built straight off the array in
 * upload order — so a person who attached a pose and then a character got
 * lines numbering the character 1 and pictures putting the pose there. The
 * blueprint pass makes a third reader of the same numbering. One function.
 */
export function orderReferences(references = [], defaults = {}) {
  const roles = defaults.image_reference_roles ?? {};
  const order = Object.keys(roles);
  const usable = references.filter((r) => r && typeof r === 'object');

  const byRole = new Map();
  for (const ref of usable) {
    const role = roles[ref.role] ? ref.role : (defaults.default_image_reference_role ?? order[0]);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push({ ...ref, role });
  }

  const out = [];
  // Registry order first, then any role the registry does not declare — which
  // can only happen through a hand-written request, and is still better
  // handled than dropped.
  for (const role of [...order, ...[...byRole.keys()].filter((r) => !order.includes(r))]) {
    out.push(...(byRole.get(role) ?? []));
  }
  return out;
}

/**
 * Reference lines for an image model, plus anything worth warning about.
 *
 * @param references [{ role, fidelity, tags[], note, character }]
 * @param defaults   registry defaults: image_reference_roles,
 *                   reference_fidelity, max_image_references
 * @param model      the registry entry, for tag_style
 * @param opts.carriesImage
 *                   whether the pictures themselves are going up with this
 *                   request. Changes what the block SAYS, not what it lists:
 *                   with the image on the wire these lines annotate something
 *                   the model can look at, and without it they are the whole
 *                   of what it gets. Saying "you cannot see the pictures" to
 *                   a model that is looking at one is the failure this flag
 *                   exists to prevent.
 * @returns { lines, warnings }
 */
export function formatImageReferences(references = [], defaults = {}, model = {}, { carriesImage = false } = {}) {
  const roles = defaults.image_reference_roles ?? {};
  const fidelities = defaults.reference_fidelity ?? {};
  const max = defaults.max_image_references ?? 6;

  // Tags arrive in danbooru's underscore spelling and are converted HERE
  // rather than in the browser, because this is the side that knows the
  // model's tag_style. A frontend that converted first would send `purple
  // hair` to a model wanting `purple_hair`, and there would be no underscore
  // left to convert back from.
  //
  // Mirrors tagForModel in web/app.js exactly, including the default: a model
  // with no tag_style is a prose model, and underscores read badly in a
  // sentence. The direction is load-bearing and must never become dash —
  // dash cannot tell `t-shirt` from `long-hair`.
  const spell = (tag) => (model?.tag_style === 'underscore' ? tag : String(tag).replace(/_/g, ' '));

  const lines = [];
  const warnings = [];
  const usable = references.filter((r) => r && typeof r === 'object');
  if (!usable.length) return { lines, warnings };

  const ordered = orderReferences(usable, defaults);
  const byRole = new Map();
  for (const ref of ordered) {
    if (!byRole.has(ref.role)) byRole.set(ref.role, []);
    byRole.get(ref.role).push(ref);
  }

  let n = 0;
  {
    for (const ref of ordered) {
      const role = ref.role;
      n += 1;
      const roleDef = roles[role] ?? {};
      const fidelityKey = fidelities[ref.fidelity]
        ? ref.fidelity
        : (defaults.default_reference_fidelity ?? Object.keys(fidelities)[0]);
      // A role may override the fidelity wording, and the brief-driven ones
      // must. The shared rules were written for aspect roles, where "the
      // traits listed for this reference" meant the tags somebody picked:
      // `exact` says "take nothing else from that picture" and `attribute`
      // says "ignore everything else about it", both of which are the exact
      // opposite of General's contract that everything unmentioned stays.
      //
      // Found 9 Sep 2026 by printing the compile message per fidelity rather
      // than reasoning about it — the two instructions were contradicting
      // each other in the same eight lines and nothing said so.
      const fidelityDef = roleDef.fidelity_rules?.[fidelityKey]
        ? { ...fidelities[fidelityKey], ...roleDef.fidelity_rules[fidelityKey] }
        : (fidelities[fidelityKey] ?? {});

      const head = [`Reference ${n} — ${roleDef.label ?? role}`];
      // `rule` is written for the person reading the dropdown. A role whose
      // rule says something only a person should hear — "being tried against
      // General, pick whichever gives you better output" went out as an
      // instruction about somebody's photograph on 9 Sep 2026 — declares
      // `compile_rule` and that goes to the model instead.
      // The role's own rule, so the model is told what that word covers
      // rather than left to infer it. "Pose" alone reads as "there is a
      // person"; "posture, body orientation, hands, and where the gaze goes"
      // is the instruction.
      if (roleDef.compile_rule ?? roleDef.rule) head.push(roleDef.compile_rule ?? roleDef.rule);
      lines.push(`- ${head.join(': ')}`);

      // A named character is the strongest thing a reference can carry, so it
      // goes first and goes on its own line. Everything else about the
      // picture is describable; a character is a lookup, and the traits under
      // it came from danbooru rather than from the model's memory — which is
      // the whole reason the traits panel exists.
      //
      // Gated by role for the same reason the tags are. Being the strongest
      // line makes it the worst one to leak: a Pose reference is a picture of
      // somebody else borrowed for a posture, and naming her puts her in the
      // output. The browser gates this as well and always has; that is not a
      // reason for the server not to, and a second caller of this formatter
      // would have found out the hard way.
      //
      // Two different questions, and they were one until 6 Sep 2026:
      // `recognised` is who the tagger saw, which every role needs to know so
      // it can keep her name OUT of the tag list; `named` is whether this
      // role gets to say so. An Outfit reference of a Frieren picture must
      // not carry `frieren` in either line — the coat is the ask, and her
      // name renders the whole elf.
      const recognised = ref.character || null;
      const named = recognised && ROLE_CARRIES_CHARACTER.has(role) ? recognised : null;
      if (named) {
        lines.push(`  character: ${spell(named)}`);
      }
      // Whose coat it is. In a two-character scene an outfit reference is
      // ambiguous and the model has no way to resolve it — naming the
      // character it attaches to is the whole of the fix. Stated before the
      // tags, because it changes what they are about.
      if (ref.applies_to) {
        lines.push(`  applies to: ${spell(ref.applies_to)}`);
      }
      // Whatever the person clicked, and nothing else.
      //
      // This used to be the tagger's whole list, filtered by role. The filter
      // existed because the list was automatic and a tagger has no idea which
      // aspect of a picture was being asked of it — reported 27 Aug 2026, a
      // Frieren reference arriving with `blurry`, `brick_wall` and
      // `artist_name` in it, which under "reproduce faithfully" are
      // instructions to reproduce the blur.
      //
      // Nothing is automatic now, so there is nothing to protect against.
      // ROLE_KEEPS still exists and still does that job — in the browser,
      // where it greys the chips a role does not usually want, and where the
      // person can overrule it by clicking one anyway. Re-applying it here
      // would silently discard exactly those overrules.
      const detected = Array.isArray(ref.tags) ? ref.tags : [];
      // The tagger returns `frieren` as a character tag, so on a Character
      // reference she would otherwise arrive twice — once on the strong line
      // above and once buried mid-list among sixteen others. Same claim,
      // weaker the second time, and it spends a slot.
      //
      // `recognised` and not `named`, so this also strips her from the roles
      // that are not allowed to name her. The tag categories do not survive
      // the wire — the browser sends raw strings — so this field is the only
      // thing on this side that knows `frieren` is a person and not a
      // hairstyle.
      //
      // Only an exact match. A hand-typed name that differs from what the
      // tagger saw is two different claims, and both are worth sending.
      const usableTags = detected.filter((t) => String(t) !== String(recognised));
      if (usableTags.length) {
        // "picked" rather than "detected". The word was accurate when a
        // tagger chose these and is a lie now that a person did — and the
        // difference matters to the model, which should weight a tag someone
        // deliberately clicked above one a CPU scored at 0.31.
        lines.push(`  tags they picked: ${usableTags.map(spell).join(', ')}`);
      }
      // What the person typed. Last of the three, because it is the one that
      // overrides: a note saying "only the hair" beats ten detected tags.
      if (ref.note) {
        lines.push(`  take from it: ${ref.note}`);
      }
      if (fidelityDef.rule) {
        lines.push(`  how closely: ${fidelityDef.rule}`);
      }

      // A reference with no tags and no note used to be an empty reference.
      // It is the ordinary case now — the picture is what carries it, and
      // picking no tags at all is a reasonable thing to do deliberately.
      //
      // So the only version of this still worth saying is the one where
      // nothing carries it: no picture on the wire, nothing picked, nothing
      // typed. Then the model really does get a label and a role rule, and
      // the person holding the picture has no way to tell.
      if (!carriesImage && !usableTags.length && !ref.note) {
        const label = roleDef.label ?? role;
        warnings.push(
          `Reference ${n} is carrying nothing: the model cannot see this picture, and nothing was picked from it or typed under it. Pick some tags, say what to take from it, or switch to a model that can see.`
        );
      }
    }
  }

  if (usable.length > max) {
    warnings.push(
      `${usable.length} reference images, and ${max} is the ceiling — past that they start contradicting each other`
    );
  }

  // Two references claiming the same role at "reproduce faithfully" is not an
  // error, but it is an instruction the model cannot satisfy: it has been told
  // to carry two different sets of traits through unchanged into one picture.
  // Warned rather than refused — a person may well mean "these two outfits,
  // pick from both" — and warned per role rather than once, so the message
  // names which one.
  for (const [role, group] of byRole) {
    const exact = group.filter(
      (r) => (fidelities[r.fidelity] ? r.fidelity : defaults.default_reference_fidelity) === 'exact'
    );
    if (exact.length > 1) {
      warnings.push(
        `${exact.length} ${roles[role]?.label ?? role} references are all set to reproduce faithfully, which cannot all be true at once`
      );
    }
  }

  return { lines, warnings };
}
