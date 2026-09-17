# Motion-Design Premium Rubric (manual)

The golden eval (`golden.eval.test.ts`) measures STRUCTURE statically (no slop, a camera move,
and big text). It cannot measure TASTE. After a generation run, rate the output 1-5 on each
dimension below and record the scores alongside the run. The rubric exists so "premium" stops
being a vibe and becomes a number.

| #   | Dimension                       | 1 (slop)                           | 5 (premium)                                              |
| --- | ------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| 1   | Camera motion                   | static frame, no move              | camera travels between beats; the move IS the transition |
| 2   | Text scale                      | small captions (<48px)             | big kinetic headlines (80-170px) that own the frame      |
| 3   | One-beat-at-a-time              | everything accumulates on screen   | one beat framed; new text REPLACES the old               |
| 4   | Handoff overlap                 | hard cut / dead-zone between beats | mid-travel you see both outgoing + incoming              |
| 5   | Depth                           | flat fills                         | shadow/glow/parallax; objects sit in space               |
| 6   | Direction variety (multi-scene) | same L→R move every scene          | axis varies (descend, rise, zoom, R→L) per scene         |
| 7   | Narration sync                  | text untimed to VO                 | beats land on the phrase they illustrate                 |

**Premium bar:** mean >= 4.0 with no dimension at 1. Record the mean + per-dimension scores
per evaluated scene.
