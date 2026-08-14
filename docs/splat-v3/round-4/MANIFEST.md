# SKI SPLAT v3 — ROUND-0 visual baseline

Captured against HEAD, fixed seed 42, viewport 1280x720, shadows + full post stack ON.

| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |
|---|---|---|---|---|---|---|
| v3-wide-vista.png | wide vista — z 60-90, v>15, steer held 0 | 1280x720 | 790KB | 2s | z=65.7, v=15.3, airborne=false | ok |
| v3-descent.png | mid-descent at speed — z 250-300, v>20 | 1280x720 | 878KB | 1.8s | z=256.7, v=25.2, airborne=false | ok |
| v3-veg-margin.png | vegetation margin — z 150-200, plants near the corridor | 1280x720 | 881KB | 1.7s | z=154.1, v=17.7, airborne=false | ok |
| v3-forest-wall.png | corridor bend — z 330-380, |x| local max | 1280x720 | 717KB | 1.6s | z=350, v=7.8, airborne=false | ok |
| v3-atmosphere.png | atmosphere/distance haze — z 400-500 | 1280x720 | 751KB | 2s | z=405.7, v=15.7, airborne=false | ok |
| v3-air.png | airborne, near peak height | 1280x720 | 820KB | 1.7s | z=562.3, v=7.2, airborne=true | ok — no kicker launch achieved within budget; used manual setJump() timed to its computed ballistic apex (~112ms after launch) |
| v3-body-pov.png | first-person body/carve — |steer|=1, v>18 | 1280x720 | 766KB | 1.3s | z=711.4, v=10.3, airborne=false | ok — v never exceeded 18 within the 5000ms hold budget (last v=10.3) — the hold is kept short because CARVE_SCRUB bleeds speed fast under a sustained lock |
| v3-finish.png | near the finish line — z>760 | 1280x720 | 706KB | 1.3s | z=761, v=10.8, airborne=false | ok |
| v3-hud-ipad.png | iPad HUD + touch zones during racing | 2048x1536 | 2343KB | 3.3s | z=22.1, v=10.5, airborne=false | ok |
| v3-results.png | results screen | 1280x720 | 705KB | 1.3s | z=766.1, v=11.2, airborne=false | ok |
