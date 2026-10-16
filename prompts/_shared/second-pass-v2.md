# Second pass

You wrote the prompt below. Read the brief again, then read what you wrote,
then write it again better.

This is a revision, not a fresh start. Most of what you wrote is probably
right, and the version you return should look like the one you sent with its
faults fixed — not like a different answer to the same brief.

**A revision is not a trim.** Returning a shorter prompt is not the goal and
is not evidence the pass worked. If the draft was already the right length,
the pass that fixes one contradiction and changes nothing else is the correct
one.

## Two layers, and only one of them is yours to cut

**Scene facts** are what is in the picture: the subject, who they are, what
they look like, what they wear, what they hold, what they are doing, and what
is around them. These have to come from the brief, from the person, or from a
lookup the app ran for you.

**Direction** is how the picture is made: framing, camera position, lens,
focus, light quality, palette, atmosphere, mood, material, finish, grain.
These do **not** have to appear in the brief to belong in the prompt. A brief
that never says "shallow depth of field" is not contradicted by it. Direction
is the part of a prompt a person is paying you to supply.

Cut an invented scene fact. Leave the direction alone.

## Read for these, in this order

**Something the brief asked for that is not in the prompt.** A named object, a
time of day, an action, a constraint. This is the failure that matters most,
because nothing downstream can recover it.

**An invented scene fact.** A prop nobody mentioned, an outfit you filled in, a
character trait — hair colour, eye colour, a marking — that came from the
vocabulary rather than from the person or the lookup. Cut it unless the image
genuinely does not work without it. This test applies to scene facts only; do
not run it over the direction layer.

**Two things that cannot both be true.** A light source in one place and its
shadows in another. A time of day fighting the lighting. A framing that cannot
contain what you put in the frame.

**The shape this model wants.** Its own instructions above say what that is:
the order, the length, where prose goes and where tags go. Check yourself
against them rather than against what reads well.

## Never cut these

- **A character's name or their series.** Both are format, not decoration, and
  a series tag is how the model knows which character it is. Neither has to be
  named in the brief to belong in the prompt.
- **Anything a lookup supplied** — a character's canonical traits, tags read
  from a reference picture. Those did not arrive with the vocabulary; the app
  went and fetched them.
- **Quality, safety, meta and year tags.** They are the format's, not the
  brief's.
- **Anything the person supplied verbatim**: text they asked to appear, tags
  they picked, a trigger word, a weight the interface set.

## What not to do

Do not add scene facts for their own sake — a new prop, a new character, a new
place. Adding direction the draft was missing is a legitimate improvement, not
padding.

Do not restate the brief back. Do not explain what you changed inside the
prompt itself.

## Return

The same segments, the same labels, the same `===SEGMENT: Label===` format.
Every one of them, whether or not it changed.

If a segment was already right, return it exactly as it was — unchanged is a
legitimate answer and a better one than a reworded version of something that
was fine.
