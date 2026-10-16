#!/usr/bin/env python3
"""Fill a brief with random ideas, mechanically.

No model is involved at any point. This reads config/randomizer.json, resolves
the templates for the categories asked for, and prints JSON. The server writes
the result into the person's brief box and stops there — what the LLM later
does with the brief is the normal generation path, unchanged. The owner's
rule: deterministic work goes in code, and the model's only job is writing
prompts.

── What a category holds ──────────────────────────────────────────────────

A template, exactly as written in the source workflow. Two shapes, and the
same code handles both because the second is just the first repeated:

  flat      {blonde hair|black hair|red hair}
            One group. Pick one option.

  composed  {angel wings|white wings}, {halo|no halo|no halo}, {glowing|dim}
            Several groups separated by whatever the author wrote between
            them. Pick one option from EACH, keep the punctuation. This is
            what makes "Angel" come out as a coherent angel rather than a
            loose wing, and 96 of the 166 source categories are this shape.

Repeated options are weighting and are honoured: `no halo|no halo` asks for no
halo twice as often as a broken one. Nothing is deduplicated, ever.

Text outside a group is kept verbatim, so `slimegirl, {gooey|gelatinous}`
always contributes `slimegirl`.

Usage:
  randomizer.py --list [--config F]
  randomizer.py --roll --categories a,b,c [--seed N] [--config F]

`--categories` takes box ids and sub-category ids interchangeably. A box id
expands to every sub-category inside it, which is the "tick the whole box"
behaviour the panel offers.

Errors print {"error": ...} on stdout and exit non-zero.
"""

import argparse
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_CONFIG = os.path.join(ROOT, "config", "randomizer.json")

# No nesting. `[^{}]` cannot match an inner brace, so a nested group is left
# alone rather than half-expanded — matching the source workflow's own
# behaviour, where nothing nests either.
GROUP = re.compile(r"\{([^{}]*)\}")


def die(message):
    print(json.dumps({"error": message}))
    sys.exit(1)


def load_config(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        die("config/randomizer.json is missing.")
    except json.JSONDecodeError as exc:
        die("config/randomizer.json is not valid JSON: %s" % exc)
    cats = data.get("categories")
    if not isinstance(cats, list) or not cats:
        die("config/randomizer.json has no categories.")
    return cats


# A trailing `:N` is a weight. Anything else after a colon is part of the term,
# so `1girl:3` weighs three and `style: cinematic` is just a term with a colon.
WEIGHT = re.compile(r"^(.*?):(\d{1,3})$")

# Options that mean "this slot contributes nothing this time".
#
# In the source workflow these had to be written as words — `no halo`, `no
# rain` — because the ComfyUI picker had no way to say "skip", and repeating
# them was the only way to make skipping more likely. Both were workarounds
# for a picker without weights, and this script has weights.
#
# So `no halo` now resolves to nothing at all rather than putting the words
# "no halo" into a brief. **The odds are unchanged** — the option is still in
# the draw and still as likely to win — it just contributes silence when it
# does. That matters here in a way it did not in ComfyUI: a brief goes to an
# LLM that reads it, and "no aura, no rain, no wind" is an instruction it may
# honour by writing those words into the prompt.
NOOP = re.compile(r"^(?:no\s+\S.*|none|nothing)$", re.IGNORECASE)


def parse_options(body):
    """`a|b:3|c` -> ([a, b, c], [1, 3, 1]). Never empty."""
    terms, weights = [], []
    for piece in body.split("|"):
        text = piece.strip()
        weight = 1
        m = WEIGHT.match(text)
        if m:
            text = m.group(1).strip()
            weight = max(1, int(m.group(2)))
        terms.append(text)
        weights.append(weight)
    return terms, weights


def option_count(template):
    """Distinct options, not total weight — this is what a person can pick."""
    return sum(len(parse_options(m.group(1))[0]) for m in GROUP.finditer(template))


def resolve(template, rng):
    """One option from every group; everything else verbatim.

    Duplicated options still weigh what they always did — `a|b|b` picks b two
    times in three — so nothing needs rewriting to keep working. `b:2` says the
    same thing once, which is what the generated config now uses.
    """
    def pick(match):
        terms, weights = parse_options(match.group(1))
        chosen = rng.choices(terms, weights=weights, k=1)[0]
        return "" if NOOP.match(chosen) else chosen

    # Resolved repeatedly, innermost first, so a group can contain a group:
    #
    #   {{red|green|black} scales|no scales:3}
    #
    # reads as "one time in four there are scales, and when there are, the
    # colour is one of these". GROUP only matches a group with no braces
    # inside it, so the colour resolves first and the outer choice then picks
    # between the coloured option and the absent one — which is the odds the
    # author wrote, kept where they can be read.
    #
    # Writing that flat costs `no scales:36`, an opaque number that has to be
    # recomputed whenever a colour is added. Nesting says the same thing and
    # survives editing. Owner's ask, 5 Sep 2026.
    #
    # Bounded rather than `while`: a template is hand-written and three levels
    # is already more nesting than anything here needs, so a runaway is a
    # malformed template rather than a case to support.
    out = template
    for _ in range(4):
        if not GROUP.search(out):
            break
        out = GROUP.sub(pick, out)
    # A skipped slot leaves ", ," or a stranded comma behind. The author wrote
    # the separators for a full template, so clearing up after a skip is this
    # function's job rather than theirs.
    out = re.sub(r"\s*,\s*(?=,)", "", out)
    out = re.sub(r"^[\s,]+|[\s,]+$", "", out)
    out = re.sub(r"\s{2,}", " ", out)
    return out.strip()


# How many people, by count. NOT a random category — the owner picks the
# numbers and gets exactly them, which is why these live here rather than in
# config/randomizer.json alongside things that are drawn.
#
# It was briefly a weighted random list, and that was wrong for the same
# reason a seed field would be: "how many people are in this shot" is a
# decision, not a draw. Mirrors the two sliders in the source workflow.
CAST_WOMEN = {1: "1girl", 2: "2girls", 3: "3girls, multiple girls", 4: "4girls, multiple girls"}
CAST_MEN = {1: "1boy", 2: "2boys", 3: "3boys, multiple boys", 4: "4boys, multiple men"}


def cast_terms(women, men):
    """Exact cast text for the chosen counts. 0 or absent contributes nothing."""
    out = []
    if women in CAST_WOMEN:
        out.append(CAST_WOMEN[women])
    if men in CAST_MEN:
        out.append(CAST_MEN[men])
    return out


# ── Surprise me ────────────────────────────────────────────────────────────
#
# Pick the categories as well as the terms, so a person who does not know what
# they want gets something whole.
#
# **Not a uniform draw over all 265 sub-categories.** That gives a mermaid
# with a tiger tail holding a rocket launcher in a classroom — every term
# valid, the picture incoherent. So this is a plan rather than a shuffle:
# things that are always true of a picture are always picked, things that are
# sometimes true are picked sometimes, and the two that cannot be doubled are
# capped at one.
#
# The caps are the whole reason it works. ONE species, or you get a chimera of
# whatever was drawn; ONE clothing theme, or the outfit fights itself.
#
# How many sub-categories a Surprise roll draws.
SURPRISE_COUNT = 10

# Boxes where two draws contradict each other rather than combining.
#
# The ONLY constraint on an otherwise uniform draw, and it earns its place:
# two species is not variety, it is a chimera with a tiger tail and a fish
# tail, and no model can render both. Everything else is allowed to collide —
# a randomizer that refuses to surprise you is not doing its job.
SURPRISE_EXCLUSIVE = [
    ['Mammals', 'Birds, reptiles & amphibians', 'Aquatic', 'Insects & arachnids',
     'Plants & fungi', 'Mythical', 'Undead & horror'],
    ['Clothing female', 'Clothing male'],
]


def surprise_pick(cats, rng, women, men, count=SURPRISE_COUNT, allow=None):
    """`count` sub-categories at random, one draw from each.

    `allow` is what the person ticked. Given, the draw happens only inside it,
    so the same tick boxes that mean "roll exactly these" for a normal roll
    mean "choose from these" for a Surprise. Empty, everything is in play
    except NSFW — the owner's reason for wanting this at all was reaching for
    Surprise and being handed a piledriver.

    Clothing follows the cast either way: a men-only roll should not reach
    into the women's wardrobe, so the box that does not match is dropped
    before the draw rather than excluded after it.
    """
    allow = set(allow or ())
    skip = set()
    # Only when nothing was ticked. Tick NSFW and you get NSFW.
    if not allow:
        skip.add('NSFW')
    if men and not women:
        skip.add('Clothing female')
    elif women:
        skip.add('Clothing male')

    pool = []
    for c in cats:
        box = c.get('label')
        if box in skip:
            continue
        for k in children_of(c):
            if not (k.get('templates') and k.get('id')):
                continue
            # A ticked box counts as ticking everything in it, same as a roll.
            if allow and not (k.get('id') in allow or c.get('id') in allow):
                continue
            pool.append((box, k.get('id')))
    if not pool:
        return []

    rng.shuffle(pool)
    picked = []
    used = [set() for _ in SURPRISE_EXCLUSIVE]
    for box, cid in pool:
        if len(picked) >= count:
            break
        clash = False
        for i, group in enumerate(SURPRISE_EXCLUSIVE):
            if box in group:
                if used[i]:
                    clash = True
                else:
                    used[i].add(box)
        if clash:
            continue
        picked.append(cid)
    return picked


def parse_limits(text):
    """`hair=2,eyes=1` -> {'hair': 2, 'eyes': 1}. Bad pairs are ignored."""
    out = {}
    for pair in str(text or "").split(","):
        if "=" not in pair:
            continue
        box, _, n = pair.partition("=")
        box = box.strip()
        try:
            n = int(n)
        except ValueError:
            continue
        if box and n > 0:
            out[box] = n
    return out


def apply_limits(cats, wanted, limits, rng):
    """Keep at most `limits[box]` of the chosen sub-categories per box.

    Ticking a box means every sub-category in it, which for Eyes is five terms
    about eyes in one brief. The stepper in each box header says how many of
    them to actually use, and the choice of WHICH is random — that is the point
    of a randomizer, and picking the first two alphabetically would make Sclera
    unreachable forever.
    """
    if not limits:
        return wanted
    kept = set(wanted)
    for c in cats:
        box = c.get("id")
        n = limits.get(box)
        if not n:
            continue
        kids = [k.get("id") for k in children_of(c) if k.get("id")]
        # A ticked BOX arrives as the box id and only expands to its children
        # further down, so it has to be expanded here or there is nothing to
        # trim — which is exactly how this failed the first time.
        if box in kept:
            kept.discard(box)
            here = kids
        else:
            here = [k for k in kids if k in kept]
        if len(here) > n:
            here = rng.sample(here, n)
        # Clear the box out first. Sampling down and then adding the survivors
        # back leaves the ones that lost still sitting in the set.
        for k in kids:
            kept.discard(k)
        kept.update(here)
    return kept


def children_of(cat):
    """Every leaf under a category. A box has children; a leaf is its own."""
    kids = cat.get("children")
    if isinstance(kids, list) and kids:
        return kids
    return [cat]


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--roll", action="store_true")
    ap.add_argument("--categories", default="")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--women", type=int, default=0)
    ap.add_argument("--men", type=int, default=0)
    ap.add_argument("--surprise", action="store_true")
    ap.add_argument("--surprise-count", type=int, default=SURPRISE_COUNT)
    ap.add_argument("--limits", default="")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    args = ap.parse_args()

    cats = load_config(args.config)

    if args.list:
        out = []
        for c in cats:
            kids = []
            for k in children_of(c):
                total = sum(option_count(t) for t in k.get("templates") or [])
                kids.append({
                    "id": k.get("id"),
                    "label": k.get("label", k.get("id")),
                    # So the panel can say how much is behind a tick box, and a
                    # sub-category that matches nothing is visible before
                    # anyone rolls it.
                    "options": total,
                })
            out.append({
                "id": c.get("id"),
                "label": c.get("label", c.get("id")),
                "children": kids,
            })
        print(json.dumps({"categories": out}))
        return

    if not args.roll:
        die("Nothing to do — pass --list or --roll.")

    rng = random.Random(args.seed) if args.seed is not None else random.Random()

    if args.surprise:
        # The categories are chosen here rather than by the person, so whatever
        # they had ticked is ignored on purpose — Surprise means surprise.
        ticked = {c.strip() for c in args.categories.split(',') if c.strip()}
        wanted = set(surprise_pick(cats, rng, args.women, args.men,
                                   max(1, min(40, args.surprise_count)), ticked))
    else:
        wanted = {c.strip() for c in args.categories.split(",") if c.strip()}
        # Surprise already decides how many it takes, so a per-box limit only
        # applies to a normal roll.
        wanted = apply_limits(cats, wanted, parse_limits(args.limits), rng)
    cast = cast_terms(args.women, args.men)
    if not wanted and not cast:
        die("Pick at least one category.")

    known = set()
    for c in cats:
        known.add(c.get("id"))
        for k in children_of(c):
            known.add(k.get("id"))
    unknown = sorted(wanted - known)
    if unknown:
        die("Unknown categor%s: %s" % ("y" if len(unknown) == 1 else "ies", ", ".join(unknown)))

    boxes = []
    for c in cats:
        # Ticking the box is ticking everything in it.
        whole = c.get("id") in wanted
        chosen = [k for k in children_of(c) if whole or k.get("id") in wanted]
        if not chosen:
            continue
        rolled = []
        for k in chosen:
            templates = k.get("templates") or []
            if not templates:
                continue
            # Several templates under one name means several independent ways
            # to write that thing; pick one, then resolve it.
            text = resolve(rng.choice(templates), rng)
            if text:
                rolled.append({
                    "id": k.get("id"),
                    "label": k.get("label", k.get("id")),
                    "text": text,
                })
        if rolled:
            boxes.append({
                "id": c.get("id"),
                "label": c.get("label", c.get("id")),
                "picks": rolled,
            })

    # Cast leads. "1girl" belongs at the front of a booru prompt, and it reads
    # first in a sentence too — everything after it describes those people.
    flat = cast + [p["text"] for b in boxes for p in b["picks"]]

    # One term, once.
    #
    # Categories overlap by nature: tick Tiger and Vampire and both offer
    # "fangs", tick two species and both offer "slit pupils". Each was right to
    # include it, and the brief still only wants to say it once — a repeated
    # term reads as emphasis to a model, which is not what a coincidence
    # deserves.
    #
    # Done on the flattened comma list rather than per category, because the
    # duplicate is usually BETWEEN two categories and invisible inside either.
    # Order is kept: first mention wins, so the cast still leads.
    seen = set()
    unique = []
    for chunk in ", ".join(flat).split(","):
        term = chunk.strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(term)

    out = {"boxes": boxes, "text": ", ".join(unique)}
    if cast:
        out["cast"] = cast
    print(json.dumps(out))


if __name__ == "__main__":
    main()
