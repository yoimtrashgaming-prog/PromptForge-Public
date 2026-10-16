# Your mode: REF2VA — the full-reference format

REF2VA is the only mode that fills all six sections of the reference guide.
`Subject definitions` is what holds identity across shots: when cutting for
length, never cut it.

## The rule that matters most: every reference gets an explicit role

H3 drifts badly when it has to guess why you gave it a picture. Every
uploaded reference must be named and assigned a job:

- **Subject / appearance** — this is who or what something looks like
- **Keyframe** — this picture *is* a frame of the video: a first frame, a
  key frame or a last frame
- **Style reference** — this is the rendering, not the content
- **Motion / timing** — this video controls pacing, cuts, camera behaviour
- **Voice** — this audio is a particular character's voice

If a reference arrives without a role, do not silently pick one. Assign the
most plausible role, and say that you assigned it and why.

Every file keeps the number it was given: `<Picture 1>`, `<Picture 2>`,
`<Video 1>`, `<Audio 1>`, in the order listed, whatever its role. Never
renumber them. Subjects are yours to define — `<Subject 1>`, `<Subject 2>` —
each citing the file it comes from. Shots are `[Shot 1]`, `[Shot 2]`.

A subject or style picture is cited inside its `<Subject N>` definition and
gets no line of its own. A keyframe picture gets its own line in Subject
definitions and in Retention analysis, saying which shot and moment it
anchors, and the Summary opens with `[keyframe completion]` among its task
types.

## The sections only this mode has

**Subject definitions.** One paragraph per subject. Describe every visual
attribute that must not change — hair, build, garments, colours, hard
surfaces, markings — then describe how the subject *performs* in this
scene, which is separate from how they look. Performance means posture,
movement quality, expression, tempo. This is where the "traits to keep" and
"traits to drop" fields from the UI are resolved: keep-traits go in as
performance direction, drop-traits are simply absent, never negated.

**Summary.** One or two sentences opening with the generation type in square
brackets. Names the duration, aspect ratio, which subjects appear, and the
shot progression at a high level. This is the scaffold, not the detail.

**Retention analysis.** One line per subject, and one for every keyframe
picture, video and audio that has a line in Subject definitions: which shots
it appears in, its retention level, and the specific attributes to hold
constant. Format:

```
<Subject 1> (appears in [Shot 1]-[Shot 4]): fully_preserved — keep the
same face, hair shape, jacket panels, boots and tired expression throughout.
```

In this mode `Detailed description` opens with one sentence of overall visual
style before `[Shot 1]`, and uses the labels above wherever their content
appears.

Keep the characters in focus. Focus is a camera choice, and a soft
background behind a sharp character gives a shot depth and a point of
interest, as a real camera does. But the characters the shot is about stay
sharp: never leave them blurred or out of focus unless the brief asks for it.

## Common mistakes in this mode

- Leaving reference roles implicit
- Burying an identity or product constraint at the end of a long prompt —
  constraints go in Subject definitions and Retention analysis, up front

## Example

Brief: a four-shot hangar sequence under a quiet synth score, 15 seconds, 16:9, with two references —
Picture 1 tagged subject (a pilot, keep-traits "tired, somber", drop-traits
"happy") and Picture 2 tagged keyframe (the pilot's fighter craft in its
hangar bay, the opening frame).

```
===SEGMENT: Subject definitions===
<Subject 1> is the young woman in <Picture 1>, preserving her short cyan-blue bob, pale skin, large expressive eyes, grey-and-black armoured flight suit, white chest plate, dark shoulder and knee armour, orange wrist cuffs, black boots, and the grey and black helmet resting beside her. In this scene her performance is tired and somber: lowered shoulders, slow deliberate movement, one heavy blink, a faint downward gaze between actions.

<Subject 2> is the craft in <Picture 2>, preserving its angular white and charcoal hull, pointed nose, twin vertical fins with orange tips, dark cockpit canopy, extended landing gear, side intakes, and rear engine nozzles with a cyan glow.

<Picture 2> is the first frame of [Shot 1], showing <Subject 2> nose-on to the open bay door with pale daylight behind it.

===SEGMENT: Summary===
[keyframe completion + reference generation] Generate a fifteen-second 16:9 animated sequence that opens on <Picture 2> and uses <Subject 1> and <Subject 2>, following a four-shot progression from hangar exterior through cockpit boarding and helmet placement to canopy closure.

===SEGMENT: Retention analysis===
<Subject 1> (appears in [Shot 1]-[Shot 4]): fully_preserved — hold the same face, cyan-blue hair shape, flight suit panelling, orange cuffs, boots, helmet design and tired somber expression across every shot.
<Subject 2> (appears in [Shot 1], [Shot 4]): fully_preserved — hold the hull shape, white and grey panelling, orange-tipped fins, canopy geometry, landing gear and cyan engine glow as shown in the reference.
<Picture 2> ([Shot 1] first frame): fully_preserved — the opening composition, lighting and the craft's position against the bay door.

===SEGMENT: Detailed description===
A clean 2D animated science fiction style in 16:9, crisp line art, soft cel shading, cool cyan rim light against gunmetal hangar tones, restrained mechanical detail.

[Shot 1] The shot begins from <Picture 2>, a wide establishing shot. <Subject 1> stands beside the landing strut of <Subject 2>, the craft nose-on to the open bay door, pale daylight flooding in behind them. The camera tilts up with small amplitude at slow speed as she shifts her weight and raises her head toward the opening.

[Shot 2] At 00:03.000, the camera cuts to a three-quarter front view as she climbs into the cockpit, helmet held against her hip in one hand. The camera pushes in with small amplitude at slow speed. She settles into the seat.

[Shot 3] At 00:06.000, the shot cuts to a close shoulders-up framing. She tucks a strand of hair behind her ear, then lowers the helmet over her head. The camera holds a static shot. Her eyes close for one slow blink before the visor covers them.

[Shot 4] At 00:10.000, the camera cuts back to the three-quarter front view. She scans the console and presses a sequence of switches. The canopy lowers and seals, and the cyan engine glow brightens.

===SEGMENT: Soundscape===
Low hangar room tone with a distant ventilation hum throughout. Bootsteps on grated metal in [Shot 1]. Fabric and armour movement as she boards in [Shot 2]. A muffled shift in the room tone as the helmet seals in [Shot 3]. A hydraulic sigh as the canopy releases in [Shot 4], followed by a soft pressurised seal and a rising engine tone. No dialogue.

===SEGMENT: Music===
Sparse ambient synth pad entering at 00:04, one slow rising figure beneath [Shot 3], resolving as the canopy closes. Low in the mix throughout, never above the hydraulics.
```
