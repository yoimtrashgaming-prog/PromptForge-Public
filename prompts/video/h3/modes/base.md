# Your mode: T2VA, I2VA, FL2VA or L2VA — the base format

These four modes use the three core fields of the base guide, not the
six-section full-reference structure. The prompt is `Detailed description`,
`Soundscape` and `Music`, and nothing else.

`Detailed description` carries what the base guide calls
`integrated_multimodal_description`, and **only** that field: the base guide's
other two core fields, `overall_soundscape` and `non_diegetic_music`, are
emitted as the `Soundscape` and `Music` segments and must not also appear
inside `Detailed description`.

A base-mode H3 prompt opens directly at `[Shot 1]`, with the visual style at
the start of that shot. It has no summary line, and the bracketed task type
that opens one — `[reference generation]`, `[keyframe completion]` and the
rest — belongs to the six-section structure alone. It uses no `<Subject N>`
labels either: a supplied picture is `<Picture 1>`, described where it
appears.

Keep the characters in focus. Focus is a camera choice, and a soft
background behind a sharp character gives a shot depth and a point of
interest, as a real camera does. But the characters the shot is about stay
sharp: never leave them blurred or out of focus unless the brief asks for it.

## Example

Brief: a tired young pilot boards her fighter in a hangar and radios "Ready
for launch.", quiet synth score, 15 seconds, 16:9, T2VA.

```
===SEGMENT: Detailed description===
[Shot 1] 2D animated science fiction, crisp line art, soft cel shading, cool cyan rim light against gunmetal hangar tones. A wide establishing shot frames a young pilot with a short cyan-blue bob and a grey-and-black armoured flight suit beside the landing strut of an angular white and charcoal fighter, pale daylight flooding through the open bay door behind them. The camera tilts up with small amplitude at slow speed as she shifts her weight and raises her head toward the opening.

[Shot 2] At 00:03.000, the camera cuts to a three-quarter front view as she climbs into the cockpit, helmet held against her hip in one hand. The camera pushes in with small amplitude at slow speed. She settles into the seat with lowered shoulders.

[Shot 3] At 00:06.000, the shot cuts to a close shoulders-up framing. She tucks a strand of hair behind her ear, then lowers the helmet over her head. The camera holds a static shot. Her eyes close for one slow blink before the visor covers them.

[Shot 4] At 00:10.000, the camera cuts back to the three-quarter front view. She scans the console and presses a sequence of switches. The canopy lowers and seals, and the cyan engine glow brightens. The young pilot with a low, tired voice (S1) says: <d>[English] Ready for launch.</d>

===SEGMENT: Soundscape===
Low hangar room tone with a distant ventilation hum throughout. Bootsteps on grated metal in [Shot 1]. Fabric and armour movement as she boards in [Shot 2]. A muffled shift in the room tone as the helmet seals in [Shot 3]. A hydraulic sigh as the canopy releases in [Shot 4], followed by a soft pressurised seal and a rising engine tone.

===SEGMENT: Music===
Sparse ambient synth pad entering at 00:04, one slow rising figure beneath [Shot 3], resolving as the canopy closes. Low in the mix throughout, never above the hydraulics.
```
