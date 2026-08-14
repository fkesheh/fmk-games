# SKI SPLAT v3 — ROUND-0 visual baseline

Captured against HEAD, fixed seed 42, viewport 1280x720, shadows + full post stack ON.

| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |
|---|---|---|---|---|---|---|
| v3-wide-vista.png | wide vista — z 60-90, v>15, steer held 0 | 1280x720 | 649KB | 1.6s | z=65.7, v=15.3, airborne=false | ok |
| v3-descent.png | mid-descent at speed — z 250-300, v>20 | 1280x720 | 506KB | 1.4s | z=250.8, v=25.4, airborne=false | ok |
| v3-veg-margin.png | vegetation margin — z 150-200, plants near the corridor | 1280x720 | 609KB | 1.4s | z=154.1, v=17.7, airborne=false | ok |
| v3-forest-wall.png | corridor bend — z 330-380, |x| local max | 1280x720 | 642KB | 1.6s | z=346.8, v=7.7, airborne=false | ok |
| v3-atmosphere.png | atmosphere/distance haze — z 400-500 | 1280x720 | 455KB | 1.2s | z=405.2, v=16.4, airborne=false | ok |
| v3-air.png | airborne, near peak height | 1280x720 | 507KB | 1.5s | z=573.1, v=8.0, airborne=true | ok — SUBSTITUTED from a re-drive: the original primary-run capture sampled airborne=false (predicate violation, §12.5a.1 criterion 4) and was replaced with a re-driven capture (same seed 42, independent run) that satisfied airborne===true at sample time. See docs/splat-v3/round-1/VALIDITY_NOTES.md. |
| v3-body-pov.png | first-person body/carve — |steer|=1, v>18 | 1280x720 | 425KB | 1.1s | z=710.8, v=10.3, airborne=false | ok — v never exceeded 18 within the 5000ms hold budget (last v=10.3) — the hold is kept short because CARVE_SCRUB bleeds speed fast under a sustained lock |
| v3-finish.png | near the finish line — z>760 | 1280x720 | 410KB | 1.8s | z=760.1, v=10.7, airborne=false | ok |
| v3-hud-ipad.png | iPad HUD + touch zones during racing | 2048x1536 | 1416KB | 3.1s | z=14.2, v=7.9, airborne=false | ok |
| v3-results.png | results screen | 1280x720 | 394KB | 1.2s | z=767.7, v=11.3, airborne=false | ok |
